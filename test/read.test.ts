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

describe('show', () => {
  it('prints the issue, comments oldest first without deleted ones, and attachment names', async () => {
    const out = await env.ok(['show', 'ERP-12']);
    expect(out).toContain('ERP-12 Login fails on Safari');
    expect(out).toContain('Status: New');
    expect(out).toContain('Type: Bug');
    expect(out).toContain('Priority: High');
    expect(out).toContain('Severity: Critical');
    expect(out).toContain('Steps: open /login in Safari 18.');
    expect(out.indexOf('Happens on Safari only')).toBeLessThan(out.indexOf('Second comment'));
    expect(out).not.toContain('deleted words');
    expect(out).toContain('shot.png');
    expect(out).not.toContain('old.png');
    expect(out).toContain('taiga fetch ERP-12');
  });

  it('accepts lowercase refs and gives json', async () => {
    const json = JSON.parse(await env.ok(['show', 'erp-12', '--json'])) as { key: string; comments: unknown[]; attachments: unknown[] };
    expect(json.key).toBe('ERP-12');
    expect(json.comments).toHaveLength(2);
    expect(json.attachments).toHaveLength(4);
  });

  it('explains user stories, missing refs, bare numbers and unknown prefixes', async () => {
    const us = await env.run(['show', 'ERP-13']);
    expect(us.code).toBe(1);
    expect(us.err).toContain('ERP-13 is a user story; taiga-link only handles issues');
    const missing = await env.run(['show', 'ERP-999']);
    expect(missing.err).toContain('ERP-999 does not exist');
    const bare = await env.run(['show', '42']);
    expect(bare.err).toContain('Bare numbers are workgate ids');
    const unknown = await env.run(['show', 'WEB-3']);
    expect(unknown.err).toContain('Unknown prefix "WEB". Linked prefixes: ERP.');
  });
});

describe('todo', () => {
  it('lists open issues of all linked projects', async () => {
    await env.ok(['link', 'add', 'website', '--prefix', 'WEB', '--ready-status', 'Ready for test']);
    const out = await env.ok(['todo']);
    expect(out).toContain('ERP-12');
    expect(out).toContain('ERP-14');
    expect(out).toContain('WEB-3');
    expect(out).not.toContain('ERP-15');
    expect(out).toContain('Dev User');
  });

  it('--mine filters to my issues; --json', async () => {
    const mine = JSON.parse(await env.ok(['todo', '--mine', '--json'])) as { key: string }[];
    expect(mine.map((i) => i.key)).toEqual(['ERP-14']);
  });
});
