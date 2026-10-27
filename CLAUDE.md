# CLAUDE.md

## Commands

```sh
pnpm install
pnpm run verify                         # typecheck + lint + build + test (what CI runs)
pnpm run build                          # esbuild src/cli.ts -> bin/taiga
pnpm exec vitest run test/read.test.ts  # one file
```

## Build artifact

`bin/taiga` is the esbuild bundle of `src/` and is committed: the plugin runs from the git checkout (`hooks/hooks.json` calls `${CLAUDE_PLUGIN_ROOT}/bin/taiga`). Rebuild and commit it with every `src/` change; CI checks it.

Tests spawn the built binary (`test/helpers.ts`) against an in-process mock Taiga server (`test/mock-taiga.ts`). Spawns must be async, or the mock cannot answer.

## Versions

`package.json` is the source of truth; `.claude-plugin/*.json` must match (`test/versions.test.ts`, synced by `pnpm version`).

## Architecture

- `src/cli.ts`: commander definitions, thin.
- `src/config.ts`: `.taiga.json` (found from the git toplevel), URL normalization.
- `src/credentials.ts`: tokens per instance URL in the Keychain (via `security -i` stdin, never argv) or a 0600 file.
- `src/api.ts`: HTTP client, login, one refresh on 401. `src/taiga.ts`: typed endpoints and zod schemas.
- `src/refs.ts`: `PREFIX-123` parsing; only linked prefixes count.
- `src/issues.ts`: show, todo, triage, comment/finish, attachment download.
- `src/link.ts`: linking projects. `src/workgate.ts`: `wg` calls, import, hook registration.
- `src/hooks.ts`: Claude Code hooks (prompt reference expansion, confirmation for writes).
- `skills/taiga/SKILL.md`: the `/taiga` skill; keep it, the README and the CLI in sync.

## Rules

- The only Taiga writes are `comment` and `finish`. Do not add others without an explicit decision.
- Secrets never go into argv, output, the repository or tests.
- ESM, Node >= 20, TypeScript strict, local imports with `.js`. User-facing errors are `TaigaError`.
