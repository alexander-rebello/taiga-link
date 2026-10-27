import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type Env } from './helpers.js';

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
  await env.linkErp();
});
afterEach(async () => {
  await env.cleanup();
});

const patches = (): unknown[] => env.mock.requests.filter((r) => r.method === 'PATCH').map((r) => r.body);

describe('comment and finish', () => {
  it('comment sends only the comment with the current version', async () => {
    expect(await env.ok(['comment', 'ERP-12', '--text', 'Looking into it'])).toContain('Commented on ERP-12');
    expect(patches()).toEqual([{ comment: 'Looking into it', version: 3 }]);
  });

  it('finish comments and sets the ready status', async () => {
    const out = await env.ok(['finish', 'ERP-12', '--text', 'Fixed the Safari login.']);
    expect(out).toContain('ERP-12 is now "Ready for test"');
    expect(patches()).toEqual([{ comment: 'Fixed the Safari login.', version: 3, status: 12 }]);
    expect(env.mock.issues.find((i) => i.id === 100)?.status).toBe(12);
  });

  it('refuses empty text', async () => {
    expect((await env.run(['comment', 'ERP-12', '--text', '  '])).code).toBe(1);
    expect((await env.run(['finish', 'ERP-12'])).code).not.toBe(0);
    expect(patches()).toEqual([]);
  });

  it('explains a renamed ready status without writing anything', async () => {
    const file = join(env.repo, '.taiga.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('Ready for test', 'QA'));
    const r = await env.run(['finish', 'ERP-12', '--text', 'x']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Status "QA" no longer exists');
    expect(patches()).toEqual([]);
  });
});

describe('triage', () => {
  it('returns new unassigned issues since a date and all open titles', async () => {
    const json = JSON.parse(await env.ok(['triage', '--since', '2026-10-19', '--json'])) as {
      since: string;
      new: { key: string; description: string; priority: string }[];
      open: { key: string; subject: string }[];
    };
    expect(json.since).toBe('2026-10-19');
    expect(json.new.map((i) => i.key)).toEqual(['ERP-16', 'ERP-12']);
    expect(json.new[1]?.description).toContain('Safari 18');
    expect(json.open.map((i) => i.key).sort()).toEqual(['ERP-12', 'ERP-14', 'ERP-16']);
    expect(patches()).toEqual([]);
  });

  it('text output names both lists', async () => {
    const out = await env.ok(['triage', '--since', '2026-10-24']);
    expect(out).toContain('New since 2026-10-24 (1)');
    expect(out).toContain('ERP-16 Login broken in Safari');
    expect(out).toContain('All open (3)');
  });
});
