import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { TaigaError } from './errors.js';
import { configDir } from './paths.js';

const CredentialsSchema = z.object({
  authToken: z.string().min(1),
  refresh: z.string().min(1),
  username: z.string().min(1),
});

export type Credentials = z.infer<typeof CredentialsSchema>;

interface Store {
  get(url: string): Promise<Credentials | undefined>;
  set(url: string, credentials: Credentials): Promise<void>;
  delete(url: string): Promise<boolean>;
}

const SERVICE = 'taiga-link';

function encode(credentials: Credentials): string {
  return Buffer.from(JSON.stringify(credentials), 'utf8').toString('base64');
}

function decode(value: string): Credentials | undefined {
  try {
    const parsed = CredentialsSchema.safeParse(JSON.parse(Buffer.from(value.trim(), 'base64').toString('utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function securityCommand(args: readonly string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile('security', [...args], { encoding: 'utf8' }, (error, stdout) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout });
    });
  });
}

function quoteForSecurity(value: string): string {
  if (/["\\\n]/.test(value)) throw new TaigaError('Unsupported character in instance URL.');
  return `"${value}"`;
}

const keychainStore: Store = {
  async get(url) {
    const result = await securityCommand(['find-generic-password', '-s', SERVICE, '-a', url, '-w']);
    return result.code === 0 ? decode(result.stdout) : undefined;
  },
  set(url, credentials) {
    // Commands go through stdin of "security -i" so the token never appears in process arguments.
    return new Promise((resolve, reject) => {
      const child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        reject(new TaigaError(`Keychain unavailable: ${error.message}`));
      });
      child.on('close', (code) => {
        if (code === 0 && stderr.trim() === '') resolve();
        else reject(new TaigaError(`Could not store credentials in the Keychain: ${stderr.trim() || `exit ${code ?? 1}`}`));
      });
      child.stdin.end(`add-generic-password -U -s ${SERVICE} -a ${quoteForSecurity(url)} -w "${encode(credentials)}"\n`);
    });
  },
  async delete(url) {
    const result = await securityCommand(['delete-generic-password', '-s', SERVICE, '-a', url]);
    return result.code === 0;
  },
};

const FileContentSchema = z.record(z.string(), z.string());

function credentialsFile(): string {
  return join(configDir(), 'credentials.json');
}

function readFileStore(): Record<string, string> {
  const file = credentialsFile();
  if (!existsSync(file)) return {};
  const parsed = FileContentSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) throw new TaigaError(`${file} is corrupt; delete it and run "taiga login" again.`);
  return parsed.data;
}

function writeFileStore(content: Record<string, string>): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const file = credentialsFile();
  writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

const fileStore: Store = {
  get(url) {
    const value = readFileStore()[url];
    return Promise.resolve(value === undefined ? undefined : decode(value));
  },
  set(url, credentials) {
    writeFileStore({ ...readFileStore(), [url]: encode(credentials) });
    return Promise.resolve();
  },
  delete(url) {
    const content = readFileStore();
    if (!(url in content)) return Promise.resolve(false);
    writeFileStore(Object.fromEntries(Object.entries(content).filter(([key]) => key !== url)));
    return Promise.resolve(true);
  },
};

function store(): Store {
  const choice = process.env.TAIGA_LINK_STORE;
  if (choice === 'file') return fileStore;
  if (choice === 'keychain') return keychainStore;
  if (choice !== undefined && choice !== '') throw new TaigaError(`TAIGA_LINK_STORE must be "keychain" or "file", got "${choice}".`);
  return process.platform === 'darwin' ? keychainStore : fileStore;
}

export function getCredentials(url: string): Promise<Credentials | undefined> {
  return store().get(url);
}

export function setCredentials(url: string, credentials: Credentials): Promise<void> {
  return store().set(url, credentials);
}

export function deleteCredentials(url: string): Promise<boolean> {
  return store().delete(url);
}
