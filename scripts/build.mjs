import { build } from 'esbuild';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

mkdirSync('bin', { recursive: true });

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'bin/taiga',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  legalComments: 'none',
  define: { __TAIGA_VERSION__: JSON.stringify(version) },
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __tlCreateRequire } from 'node:module';",
      'const require = __tlCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});

chmodSync('bin/taiga', 0o755);
