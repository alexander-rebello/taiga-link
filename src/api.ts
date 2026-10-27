import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { z } from 'zod';
import { getCredentials, setCredentials, type Credentials } from './credentials.js';
import { TaigaError } from './errors.js';
import { configDir } from './paths.js';

const AuthResponseSchema = z.object({
  auth_token: z.string().min(1),
  refresh: z.string().min(1),
  username: z.string().min(1),
});

const RefreshResponseSchema = z.object({
  auth_token: z.string().min(1),
  refresh: z.string().min(1),
});

const TIMEOUT_MS = 20_000;

function apiUrl(base: string, path: string): string {
  return `${base}/api/v1${path}`;
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { _error_message?: unknown; detail?: unknown };
    if (typeof body._error_message === 'string') return body._error_message;
    if (typeof body.detail === 'string') return body.detail;
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text.slice(0, 200) || response.statusText;
}

async function request(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    throw new TaigaError(`Cannot reach ${new URL(url).origin}: ${cause ?? (error as Error).message}`);
  }
}

export async function login(base: string, username: string, password: string): Promise<Credentials> {
  const response = await request(apiUrl(base, '/auth'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'normal', username, password }),
  });
  if (!response.ok) {
    throw new TaigaError(`Login failed (${response.status}): ${await readError(response)}`);
  }
  const parsed = AuthResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new TaigaError('Login failed: unexpected response from Taiga.');
  return { authToken: parsed.data.auth_token, refresh: parsed.data.refresh, username: parsed.data.username };
}

const StateSchema = z.object({ defaultUrl: z.string().optional() });

function stateFile(): string {
  return join(configDir(), 'state.json');
}

/** The instance used last by "taiga login"; lets commands run before a repository is linked. */
export function defaultUrl(): string | undefined {
  const file = stateFile();
  if (!existsSync(file)) return undefined;
  const parsed = StateSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  return parsed.success ? parsed.data.defaultUrl : undefined;
}

export function setDefaultUrl(url: string | undefined): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(stateFile(), `${JSON.stringify(url === undefined ? {} : { defaultUrl: url }, null, 2)}\n`);
}

export class TaigaClient {
  readonly base: string;
  private credentials: Credentials;

  private constructor(base: string, credentials: Credentials) {
    this.base = base;
    this.credentials = credentials;
  }

  static async open(base: string): Promise<TaigaClient> {
    const credentials = await getCredentials(base);
    if (credentials === undefined) {
      throw new TaigaError(`Not logged in to ${base}. Run "taiga login" in a terminal.`);
    }
    return new TaigaClient(base, credentials);
  }

  get username(): string {
    return this.credentials.username;
  }

  async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return this.json('GET', path, undefined, schema);
  }

  async patch<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    return this.json('PATCH', path, body, schema);
  }

  /** Streams a file to dest via a temporary file, so an interrupted download never looks complete. */
  async download(url: string, dest: string): Promise<void> {
    const response = await this.send(url, { method: 'GET' }, 120_000);
    if (!response.ok || response.body === null) {
      throw new TaigaError(`Download failed (${response.status}): ${url.replace(/\?.*$/, '')}`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    const partial = `${dest}.part`;
    try {
      await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), createWriteStream(partial));
      renameSync(partial, dest);
    } catch (error) {
      rmSync(partial, { force: true });
      throw new TaigaError(`Download failed: ${(error as Error).message}`);
    }
  }

  private async json<T>(method: string, path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const init: RequestInit = {
      method,
      headers: { 'content-type': 'application/json', 'x-disable-pagination': 'True' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    const response = await this.send(apiUrl(this.base, path), init);
    if (!response.ok) {
      throw new TaigaError(`Taiga ${method} ${path} failed (${response.status}): ${await readError(response)}`);
    }
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new TaigaError(`Unexpected response from Taiga for ${path}: ${issues}`);
    }
    return parsed.data;
  }

  private async send(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<Response> {
    const withAuth = (): RequestInit => ({
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${this.credentials.authToken}` },
    });
    const first = await request(url, withAuth(), timeoutMs);
    if (first.status !== 401) return first;
    await first.body?.cancel();
    await this.refresh();
    return request(url, withAuth(), timeoutMs);
  }

  private async refresh(): Promise<void> {
    const response = await request(apiUrl(this.base, '/auth/refresh'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh: this.credentials.refresh }),
    });
    const parsed = response.ok ? RefreshResponseSchema.safeParse(await response.json()) : undefined;
    if (parsed?.success !== true) {
      throw new TaigaError(`Session for ${this.base} expired. Run "taiga login" in a terminal.`);
    }
    this.credentials = { ...this.credentials, authToken: parsed.data.auth_token, refresh: parsed.data.refresh };
    await setCredentials(this.base, this.credentials);
  }
}
