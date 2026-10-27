import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TAIGA, makeEnv, type Env } from './helpers.js';

// The sibling checkout is preferred during development; CI uses the npm package.
const sibling = resolve(import.meta.dirname, '..', '..', 'workgate', 'bin', 'wg');
const WG = process.env.WG_BIN ?? (existsSync(sibling) ? sibling : resolve(import.meta.dirname, '..', 'node_modules', 'workgate', 'bin', 'wg'));
const hasRefs = execFileSync('node', [WG, 'add', '--help'], { encoding: 'utf8' }).includes('--ref');
if (!hasRefs) console.warn(`workgate tests skipped: ${WG} has no "wg add --ref"`);

let env: Env;
let shimDir: string;

// Async on purpose: a synchronous spawn would block the in-process mock server that hooks call.
function wg(args: string[], cwd = env.repo): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn(WG, args, { cwd, env: { ...env.baseEnv, PATH: `${shimDir}:${env.baseEnv.PATH ?? ''}` } });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.on('close', (code) => {
      done({ code: code ?? 1, out, err });
    });
    child.stdin.end();
  });
}

beforeEach(async () => {
  process.env.WG_BIN = WG;
  env = await makeEnv();
  shimDir = join(env.root, 'shims');
  mkdirSync(shimDir);
  const shim = join(shimDir, 'taiga');
  writeFileSync(shim, `#!/bin/sh\nexec node "${TAIGA}" "$@"\n`);
  chmodSync(shim, 0o755);
  expect((await wg(['init'])).code).toBe(0);
  await env.linkErp();
});
afterEach(async () => {
  await env.cleanup();
});

describe.skipIf(!hasRefs)('workgate integration', () => {
  it('link registers the event hook once and leaves the files uncommitted', async () => {
    const config = JSON.parse(readFileSync(join(env.repo, '.workgate', 'config.json'), 'utf8')) as { hooks: unknown[] };
    expect(config.hooks).toEqual([{ on: ['claim', 'done'], command: 'taiga wg-hook' }]);
    const out = await env.ok(['link', 'add', 'website', '--prefix', 'WEB', '--ready-status', 'Ready for test']);
    expect(out).not.toContain('Registered');
    expect(out).toContain('Uncommitted: .taiga.json, .workgate/config.json.');
    expect(env.git(['status', '--short'])).toContain('.taiga.json');
  });

  it('import creates a linked item once, with kind, severity and the description', async () => {
    env.git(['add', '-A']);
    env.git(['commit', '-q', '-m', 'link taiga']);
    expect(await env.ok(['import', 'ERP-12'])).toContain('Created workgate #1 for ERP-12');
    const item = JSON.parse((await wg(['show', '1', '--json'])).out) as { title: string; kind: string; sev: string; refs: Record<string, string> };
    expect(item).toMatchObject({ title: '[ERP-12] Login fails on Safari', kind: 'bug', sev: 'S1', refs: { taiga: 'ERP-12' } });
    expect((await wg(['body', '1'])).out).toContain('Steps: open /login in Safari 18.');
    const again = await env.run(['import', 'ERP-12']);
    expect(again.code).toBe(1);
    expect(again.err).toContain('ERP-12 is already workgate #1 (todo)');

    await env.ok(['import', 'ERP-14']);
    expect(JSON.parse((await wg(['show', '2', '--json'])).out)).toMatchObject({ kind: 'feature' });
    expect(await env.ok(['todo'])).toMatch(/ERP-12 .*wg #1 todo/);
    expect(await env.ok(['show', 'ERP-14'])).toContain('Workgate: #2');
  });

  it('claim prints the issue and done asks for the ready-to-test handoff', async () => {
    env.git(['add', '-A']);
    env.git(['commit', '-q', '-m', 'link taiga']);
    await env.ok(['import', 'ERP-12']);
    const claim = await wg(['claim', '1']);
    expect(claim.code).toBe(0);
    expect(claim.out).toContain('taiga-link: workgate #1 is ERP-12.');
    expect(claim.out).toContain('Happens on Safari only');
    const wt = /^worktree: (.+)$/m.exec(claim.out)?.[1] ?? '';
    writeFileSync(join(wt, 'fix.txt'), 'fixed');
    const done = await wg(['done', '1', '--outcome', 'Fixed Safari login', '--no-report']);
    expect(done.code).toBe(0);
    expect(done.out).toContain('taiga finish ERP-12 --text');
    expect(env.mock.requests.filter((r) => r.method === 'PATCH')).toEqual([]);
  });

  it('wg-hook ignores unlinked items and other events', async () => {
    const quiet = async (event: string, refs?: Record<string, string>): Promise<string> =>
      env.ok(['wg-hook'], { input: JSON.stringify({ event, item: { id: 1, title: 't', status: 'todo', ...(refs === undefined ? {} : { refs }) } }) });
    expect(await quiet('claim')).toBe('');
    expect(await quiet('add', { taiga: 'ERP-12' })).toBe('');
    expect(await quiet('block', { taiga: 'ERP-12' })).toBe('');
  });

  it('import refuses outside workgate repos', async () => {
    const other = join(env.root, 'plain');
    mkdirSync(other);
    execFileSync('git', ['init', '-q'], { cwd: other });
    writeFileSync(join(other, '.taiga.json'), readFileSync(join(env.repo, '.taiga.json')));
    const r = await env.run(['import', 'ERP-12'], { cwd: other });
    expect(r.code).toBe(1);
    expect(r.err).toContain('does not use workgate');
  });
});
