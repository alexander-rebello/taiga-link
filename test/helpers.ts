import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startMockTaiga, USER, type MockTaiga } from './mock-taiga.js';

export const TAIGA = resolve(import.meta.dirname, '..', 'bin', 'taiga');

export interface RunResult {
  code: number;
  out: string;
  err: string;
}

export interface Env {
  baseEnv: Record<string, string>;
  root: string;
  repo: string;
  configDir: string;
  cacheDir: string;
  mock: MockTaiga;
  run: (args: string[], options?: { cwd?: string; input?: string; env?: Record<string, string> }) => Promise<RunResult>;
  ok: (args: string[], options?: { cwd?: string; input?: string }) => Promise<string>;
  login: () => Promise<void>;
  linkErp: () => Promise<void>;
  git: (args: string[], cwd?: string) => string;
  cleanup: () => Promise<void>;
}

export async function makeEnv(): Promise<Env> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'taiga-test-')));
  const repo = join(root, 'repo');
  const configDir = join(root, 'config');
  const cacheDir = join(root, 'cache');
  mkdirSync(repo);
  const git = (args: string[], cwd: string = repo): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'dev@example.com']);
  git(['config', 'user.name', 'Dev']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);

  const mock = await startMockTaiga();
  const baseEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    TAIGA_LINK_STORE: 'file',
    TAIGA_LINK_CONFIG_DIR: configDir,
    TAIGA_LINK_CACHE_DIR: cacheDir,
    ...(process.env.WG_BIN === undefined ? {} : { WG_BIN: process.env.WG_BIN }),
  };

  const run: Env['run'] = (args, options = {}) =>
    new Promise((done) => {
      const child = spawn('node', [TAIGA, ...args], { cwd: options.cwd ?? repo, env: { ...baseEnv, ...options.env } });
      let out = '';
      let err = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
      child.on('close', (code) => {
        done({ code: code ?? 1, out: out.trim(), err: err.trim() });
      });
      child.stdin.end(options.input ?? '');
    });
  const ok: Env['ok'] = async (args, options) => {
    const r = await run(args, options);
    if (r.code !== 0) throw new Error(`taiga ${args.join(' ')} failed (${r.code}): ${r.err}\n${r.out}`);
    return r.out;
  };

  const env: Env = {
    baseEnv,
    root,
    repo,
    configDir,
    cacheDir,
    mock,
    run,
    ok,
    git,
    login: async () => {
      await ok(['login', '--url', mock.url, '--username', USER.username, '--password-stdin'], { input: `${USER.password}\n` });
    },
    linkErp: async () => {
      await env.login();
      await ok(['link', 'add', 'acme-erp', '--prefix', 'ERP', '--ready-status', 'Ready for test']);
    },
    cleanup: async () => {
      await mock.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return env;
}
