import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type Env } from './helpers.js';

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
  await env.login();
});
afterEach(async () => {
  await env.cleanup();
});

function config(): { url: string; projects: { prefix: string; slug: string; id: number; readyStatus: string; name: string }[] } {
  return JSON.parse(readFileSync(join(env.repo, '.taiga.json'), 'utf8')) as ReturnType<typeof config>;
}

describe('projects and link', () => {
  it('lists my projects', async () => {
    const out = await env.ok(['projects']);
    expect(out).toContain('acme-erp');
    expect(out).toContain('Website');
    const json = JSON.parse(await env.ok(['projects', '--json'])) as { slug: string }[];
    expect(json.map((p) => p.slug)).toEqual(['acme-erp', 'archive', 'website']);
  });

  it('lists the issue statuses of a project', async () => {
    expect((await env.ok(['statuses', 'acme-erp'])).split('\n')).toEqual(['New', 'In progress', 'Ready for test', 'Closed (closed)']);
  });

  it('link add writes .taiga.json at the repo root, also from a subdirectory', async () => {
    await env.ok(['link', 'add', 'acme-erp', '--prefix', 'erp', '--ready-status', 'Ready for test']);
    expect(config()).toEqual({
      version: 1,
      url: env.mock.url,
      projects: [{ id: 1, slug: 'acme-erp', name: 'Acme ERP', prefix: 'ERP', readyStatus: 'Ready for test' }],
    });
    const sub = join(env.repo, 'src');
    mkdirSync(sub);
    await env.ok(['link', 'add', 'website', '--prefix', 'WEB', '--ready-status', 'Ready for test'], { cwd: sub });
    expect(config().projects.map((p) => p.prefix)).toEqual(['ERP', 'WEB']);
    expect(await env.ok(['link', 'list'])).toMatch(/ERP\s+Acme ERP.*Ready for test/);
  });

  it('re-adding a project updates it instead of duplicating', async () => {
    await env.ok(['link', 'add', 'acme-erp', '--prefix', 'ERP', '--ready-status', 'Ready for test']);
    await env.ok(['link', 'add', 'acme-erp', '--prefix', 'ACME', '--ready-status', 'In progress']);
    expect(config().projects).toEqual([{ id: 1, slug: 'acme-erp', name: 'Acme ERP', prefix: 'ACME', readyStatus: 'In progress' }]);
  });

  it('refuses unknown statuses, bad and duplicate prefixes, unknown projects', async () => {
    await env.ok(['link', 'add', 'acme-erp', '--prefix', 'ERP', '--ready-status', 'Ready for test']);
    const status = await env.run(['link', 'add', 'website', '--prefix', 'WEB', '--ready-status', 'Done-ish']);
    expect(status.code).toBe(1);
    expect(status.err).toContain('"Ready for test"');
    const dup = await env.run(['link', 'add', 'website', '--prefix', 'ERP', '--ready-status', 'New']);
    expect(dup.code).toBe(1);
    expect(dup.err).toContain('ERP is already used');
    const bad = await env.run(['link', 'add', 'website', '--prefix', 'W', '--ready-status', 'New']);
    expect(bad.code).toBe(1);
    const missing = await env.run(['link', 'add', 'nope', '--prefix', 'NO', '--ready-status', 'New']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('nope');
  });

  it('link remove', async () => {
    await env.ok(['link', 'add', 'acme-erp', '--prefix', 'ERP', '--ready-status', 'Ready for test']);
    await env.ok(['link', 'remove', 'erp']);
    expect(config().projects).toEqual([]);
    expect((await env.run(['link', 'remove', 'ERP'])).code).toBe(1);
  });

  it('refuses to link a second instance into the same repo', async () => {
    await env.ok(['link', 'add', 'acme-erp', '--prefix', 'ERP', '--ready-status', 'Ready for test']);
    const r = await env.run(['link', 'add', 'website', '--prefix', 'WEB', '--ready-status', 'New', '--url', 'https://other.example.com']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('already linked to');
  });
});
