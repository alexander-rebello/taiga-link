import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type Env } from './helpers.js';

let env: Env;
let dir: string;
beforeEach(async () => {
  env = await makeEnv();
  await env.linkErp();
  dir = join(env.cacheDir, '127.0.0.1', 'acme-erp', '12');
});
afterEach(async () => {
  await env.cleanup();
});

const mediaRequests = (): number => env.mock.requests.filter((r) => r.path.startsWith('/media/')).length;

describe('fetch', () => {
  it('downloads attachments into the cache, sanitizes names, skips videos and large files', async () => {
    const out = await env.ok(['fetch', 'ERP-12']);
    expect(readFileSync(join(dir, 'shot.png'), 'utf8')).toBe('PNGDATA');
    expect(readFileSync(join(dir, 'evil.txt'), 'utf8')).toBe('EVIL');
    expect(existsSync(join(env.cacheDir, '127.0.0.1', 'evil.txt'))).toBe(false);
    expect(existsSync(join(dir, 'clip.mp4'))).toBe(false);
    expect(out).toContain(join(dir, 'shot.png'));
    expect(out).toMatch(/skipped clip\.mp4 \(video/);
    expect(out).toMatch(/skipped huge\.zip \(30\.0 MB/);
    expect(out).not.toContain('old.png');
  });

  it('does not download again when the file is already there', async () => {
    await env.ok(['fetch', 'ERP-12']);
    const before = mediaRequests();
    const out = await env.ok(['fetch', 'ERP-12']);
    expect(mediaRequests()).toBe(before);
    expect(out).toContain('cached');
  });

  it('--all includes skipped files and reports failures with exit 1', async () => {
    const r = await env.run(['fetch', 'ERP-12', '--all']);
    expect(r.code).toBe(1);
    expect(readFileSync(join(dir, 'clip.mp4'), 'utf8')).toBe('VIDEO');
    expect(r.err).toContain('huge.zip');
    expect(existsSync(join(dir, 'huge.zip'))).toBe(false);
    expect(existsSync(join(dir, 'huge.zip.part'))).toBe(false);
  });

  it('says so when there are no attachments', async () => {
    expect(await env.ok(['fetch', 'ERP-14'])).toContain('No attachments');
  });
});
