import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type Env } from './helpers.js';
import { USER } from './mock-taiga.js';

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  await env.cleanup();
});

describe('login', () => {
  it('stores tokens with mode 0600, never the password, and prints no secret', async () => {
    const r = await env.run(['login', '--url', `${env.mock.url}/api/v1/`, '--username', 'dev', '--password-stdin'], { input: 'secret\n' });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Logged in to ${env.mock.url} as dev`);
    expect(`${r.out}${r.err}`).not.toMatch(/access-1|refresh-1|secret/);
    const file = join(env.configDir, 'credentials.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(USER.password);
    expect(Object.keys(JSON.parse(raw) as object)).toEqual([env.mock.url]);
  });

  it('fails with the server message on a wrong password', async () => {
    const r = await env.run(['login', '--url', env.mock.url, '--username', 'dev', '--password-stdin'], { input: 'nope\n' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('Username or password does not match');
  });

  it('refuses to prompt without a terminal', async () => {
    const r = await env.run(['login', '--url', env.mock.url]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('terminal');
  });

  it('whoami and logout', async () => {
    await env.login();
    expect(await env.ok(['whoami'])).toBe(`dev @ ${env.mock.url}`);
    expect(await env.ok(['logout'])).toContain('Logged out');
    const r = await env.run(['whoami']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('taiga login');
  });
});

describe('token refresh', () => {
  it('refreshes once on 401 and stores the new tokens', async () => {
    await env.linkErp();
    env.mock.expireToken();
    expect(await env.ok(['show', 'ERP-12'])).toContain('Login fails on Safari');
    expect(env.mock.requests.filter((q) => q.path === '/auth/refresh')).toHaveLength(1);
    expect(await env.ok(['show', 'ERP-12'])).toContain('Login fails on Safari');
    expect(env.mock.requests.filter((q) => q.path === '/auth/refresh')).toHaveLength(1);
  });

  it('asks to log in again when refresh fails', async () => {
    await env.linkErp();
    env.mock.expireToken();
    env.mock.revokeRefresh();
    const r = await env.run(['show', 'ERP-12']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('expired. Run "taiga login"');
  });
});
