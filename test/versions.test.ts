import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeEnv } from './helpers.js';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const plugin = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8')) as { version: string };
const market = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8')) as { plugins: { version: string }[] };

describe('versions', () => {
  it('plugin and marketplace match package.json', () => {
    expect(plugin.version).toBe(pkg.version);
    for (const p of market.plugins) expect(p.version).toBe(pkg.version);
  });

  it('--version prints the package version', async () => {
    const env = await makeEnv();
    try {
      expect(await env.ok(['--version'])).toBe(pkg.version);
    } finally {
      await env.cleanup();
    }
  });
});
