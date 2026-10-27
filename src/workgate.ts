import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { projectRoot } from './config.js';
import { TaigaError } from './errors.js';
import type { IssueView } from './taiga.js';

export const HOOK_COMMAND = 'taiga wg-hook';
export const HOOK_EVENTS = ['claim', 'done'] as const;

const WgItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  status: z.string(),
  refs: z.record(z.string(), z.string()).optional(),
});
export type WgItem = z.infer<typeof WgItemSchema>;

export function workgateConfigFile(cwd: string): string | undefined {
  const file = join(projectRoot(cwd), '.workgate', 'config.json');
  return existsSync(file) ? file : undefined;
}

export function usesWorkgate(cwd: string): boolean {
  return workgateConfigFile(cwd) !== undefined;
}

function wgBin(): string {
  return process.env.WG_BIN ?? 'wg';
}

function runWg(args: readonly string[], cwd: string, input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(wgBin(), [...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', (error) => {
      resolve({ code: 127, stdout, stderr: `cannot run ${wgBin()}: ${error.message}` });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(input ?? '');
  });
}

export async function wgItems(cwd: string): Promise<WgItem[]> {
  const result = await runWg(['list', '--all', '--json'], cwd);
  if (result.code !== 0) throw new TaigaError(`wg list failed: ${result.stderr.trim()}`);
  const parsed = z.array(WgItemSchema).safeParse(JSON.parse(result.stdout));
  if (!parsed.success) throw new TaigaError('Unexpected output from "wg list --json".');
  return parsed.data;
}

/** Taiga key to workgate item, for every item that carries refs.taiga. */
export async function itemsByKey(cwd: string): Promise<Map<string, WgItem>> {
  const map = new Map<string, WgItem>();
  for (const item of await wgItems(cwd)) {
    const key = item.refs?.taiga;
    if (key !== undefined) map.set(key, item);
  }
  return map;
}

export function kindFor(issue: IssueView): 'bug' | 'feature' {
  return /bug/i.test(issue.type) ? 'bug' : 'feature';
}

export function sevFor(issue: IssueView): 'S1' | 'S2' | 'S3' | 'S4' | undefined {
  const name = issue.severity.toLowerCase();
  if (name === 'critical') return 'S1';
  if (name === 'important') return 'S2';
  if (name === 'normal') return 'S3';
  if (name === 'minor' || name === 'wishlist') return 'S4';
  return undefined;
}

export async function supportsRefs(cwd: string): Promise<boolean> {
  const help = await runWg(['add', '--help'], cwd);
  return help.stdout.includes('--ref');
}

export async function importIssue(cwd: string, issue: IssueView, url: string): Promise<WgItem> {
  if (!(await supportsRefs(cwd))) {
    throw new TaigaError('This workgate version has no "wg add --ref". Update workgate to a version with refs and event hooks.');
  }
  const existing = (await itemsByKey(cwd)).get(issue.key);
  if (existing !== undefined) {
    throw new TaigaError(`${issue.key} is already workgate #${existing.id} (${existing.status}).`);
  }
  const kind = kindFor(issue);
  const sev = kind === 'bug' ? sevFor(issue) : undefined;
  const body = [
    `Taiga: ${issue.key} ${url}`,
    '',
    '## Description',
    '',
    issue.description.trim() === '' ? '(none in Taiga)' : issue.description.trim(),
    '',
    '## Plan',
    '',
    '- [ ] ',
  ].join('\n');
  const args = ['add', `[${issue.key}] ${issue.subject}`, '--kind', kind, '--ref', `taiga=${issue.key}`, '--json'];
  if (sev !== undefined) args.push('--sev', sev);
  const result = await runWg(args, cwd, body);
  if (result.code !== 0) throw new TaigaError(`wg add failed: ${result.stderr.trim()}`);
  return WgItemSchema.parse(JSON.parse(result.stdout));
}

const HookEntrySchema = z.object({ on: z.array(z.string()), command: z.string() }).loose();

/** Adds the taiga-link event hook to .workgate/config.json once; returns false when it was already there. */
export function registerHook(cwd: string): boolean {
  const file = workgateConfigFile(cwd);
  if (file === undefined) return false;
  const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const hooks = z.array(HookEntrySchema).catch([]).parse(config.hooks ?? []);
  if (hooks.some((h) => h.command.trim() === HOOK_COMMAND)) return false;
  config.hooks = [...hooks, { on: [...HOOK_EVENTS], command: HOOK_COMMAND }];
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}

/** The subset of paths (relative to root) that git reports as modified or untracked. */
export function changedPaths(root: string, paths: readonly string[]): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain', '--', ...paths], { cwd: root, encoding: 'utf8' }, (error, stdout) => {
      if (error !== null) {
        resolve([]);
        return;
      }
      const changed = new Set(stdout.split('\n').filter((l) => l.length > 3).map((l) => l.slice(3).trim()));
      resolve(paths.filter((p) => changed.has(p)));
    });
  });
}

export const WgEventSchema = z.object({
  event: z.string(),
  item: WgItemSchema.extend({ outcome: z.string().optional() }).loose(),
});
export type WgEvent = z.infer<typeof WgEventSchema>;
