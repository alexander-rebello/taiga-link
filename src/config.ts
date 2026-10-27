import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { TaigaError } from './errors.js';

export const CONFIG_FILE = '.taiga.json';
export const PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

const ProjectLinkSchema = z
  .object({
    id: z.number().int().positive(),
    slug: z.string().min(1),
    name: z.string().min(1),
    prefix: z.string().regex(PREFIX_PATTERN, 'prefix must be 2 to 10 characters, A-Z and 0-9, starting with a letter'),
    readyStatus: z.string().min(1),
  })
  .strict();

export const LinkConfigSchema = z
  .object({
    version: z.literal(1),
    url: z.url(),
    projects: z.array(ProjectLinkSchema),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    for (const p of cfg.projects) {
      if (seen.has(p.prefix)) ctx.addIssue({ code: 'custom', path: ['projects'], message: `duplicate prefix ${p.prefix}` });
      seen.add(p.prefix);
    }
  });

export type ProjectLink = z.infer<typeof ProjectLinkSchema>;
export type LinkConfig = z.infer<typeof LinkConfigSchema>;

/** Strips trailing slashes and a trailing /api/v1 so the same instance always maps to one credential entry. */
export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new TaigaError(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TaigaError(`Unsupported URL scheme: ${url.protocol}`);
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  return `${url.origin}${path}`;
}

/** The repository root (git toplevel), or the directory itself outside git. */
export function projectRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return cwd;
  }
}

export function findConfigFile(cwd: string): string | undefined {
  const root = projectRoot(cwd);
  let dir = cwd;
  for (;;) {
    const file = join(dir, CONFIG_FILE);
    if (existsSync(file)) return file;
    if (dir === root) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function readConfig(file: string): LinkConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new TaigaError(`${file}: invalid JSON: ${(error as Error).message}`);
  }
  const parsed = LinkConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TaigaError(`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

export interface LoadedConfig {
  file: string;
  config: LinkConfig;
}

export function loadConfig(cwd: string): LoadedConfig {
  const file = findConfigFile(cwd);
  if (file === undefined) {
    throw new TaigaError(`No ${CONFIG_FILE} found. Run "taiga link" in the repository first.`);
  }
  return { file, config: readConfig(file) };
}

export function saveConfig(file: string, config: LinkConfig): void {
  const parsed = LinkConfigSchema.parse(config);
  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
}
