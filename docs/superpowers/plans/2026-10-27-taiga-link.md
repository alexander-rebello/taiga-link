# taiga-link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship workgate refs/event hooks and the `taiga-link` CLI plus Claude Code plugin described in the spec.

**Architecture:** Two repos. Workgate gets a generic `refs` item field and config-driven event hooks. taiga-link is a TypeScript CLI (`taiga`) bundled to `bin/taiga`, with a skill and two hooks; tests run the built binary against a local mock Taiga HTTP server.

**Tech Stack:** TypeScript strict, Node >= 20, pnpm, esbuild, commander, zod, @inquirer/prompts (bundled), vitest, eslint strictTypeChecked.

**Spec:** `docs/superpowers/specs/2026-10-27-taiga-link-design.md`

## Global Constraints

- Mirror workgate's tooling: same tsconfig, eslint config, build script shape, version sync script, CI and publish workflows.
- No runtime dependencies; everything bundled into `bin/taiga`, which is committed.
- Secrets never in argv, stdout, the repo or test snapshots.
- Taiga refs always `<PREFIX>-<n>`, prefix `^[A-Z][A-Z0-9]{1,9}$`.
- Only `comment` and `finish` write to Taiga.

## Review Focus

- Expired access token: one refresh, then retry; failed refresh tells the user to log in again (test in Task 4).
- Prompt text with `UTF-8`, `ISO-9001` or unregistered prefixes: no expansion, no network (Task 7).
- Ref that resolves to a user story or task: clear "only issues" error (Task 4).
- Importing the same ref twice: refused with the existing workgate id (Task 8).
- Hook when not logged in or offline: one context line, exit 0 (Task 7).

---

### Task 1 (workgate): `refs` field and event hooks

**Files:** modify `src/types.ts`, `src/items.ts` (KEY_ORDER), `src/ops.ts` (AddOptions), `src/cli.ts`; create `src/events.ts`; test `test/events.test.ts`; docs `README.md`, `skills/wg/SKILL.md`.

**Interfaces:**
- `ItemMeta.refs?: Record<string, string>` (key `^[a-z][a-z0-9-]*$`).
- `Config.hooks: { on: WgEvent[]; command: string }[]` default `[]`; `WgEvent = 'add'|'claim'|'block'|'done'|'drop'`.
- `fireEvent(repo: Repo, event: WgEvent, item: Item): Promise<{ output: string; warnings: string[] }>` runs matching commands via shell in `repo.mainRoot`, stdin `{"event","item":{...meta,file}}`, 30 s timeout.
- `wg add --ref name=value` (repeatable).

- [ ] Tests: `wg add --ref taiga=ERP-1` stores `refs`; hook on `add`/`claim`/`done` receives JSON and its stdout is printed; failing hook prints a warning and exit code stays 0; with `--json` hook output goes to stderr; invalid ref key rejected.
- [ ] Implement, `pnpm run verify`, commit on branch `event-hooks`.

### Task 2: scaffold taiga-link

**Files:** `package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `scripts/build.mjs`, `scripts/sync-version.mjs`, `.claude-plugin/{plugin,marketplace}.json`, `.github/workflows/{ci,publish}.yml`, `src/cli.ts` (`--version`), `src/errors.ts` (`TaigaError`), `test/global-setup.ts`, `test/helpers.ts` (`runTaiga(args, {cwd, env, input})`), `test/versions.test.ts`.

- [ ] `taiga --version` prints package version; versions test passes; verify green; commit.

### Task 3: config, credentials, login

**Files:** `src/config.ts`, `src/credentials.ts`, `src/api.ts` (client core), `src/commands/login.ts`; test `test/mock-taiga.ts` (in-process HTTP server with fixtures and request log), `test/login.test.ts`.

**Interfaces:**
- `ProjectLink { id: number; slug: string; name: string; prefix: string; readyStatus: string }`, `LinkConfig { version: 1; url: string; projects: ProjectLink[] }`; `findConfigFile(cwd): string | undefined`, `loadConfig(cwd): LinkConfig`, `saveConfig(file, cfg): void`.
- `Credentials { authToken: string; refresh: string; username: string }`; `getCredentials(url)`, `setCredentials(url, c)`, `deleteCredentials(url)`; store selected by `TAIGA_LINK_STORE` (`keychain`|`file`), default keychain on darwin.
- `TaigaClient(url)`: `get<T>(path, schema)`, `patch<T>(path, body, schema)`, `download(url, dest)`; refresh on 401 once.

- [ ] Tests: `login --url --username --password-stdin` stores tokens (file store, 0600) and never prints them; wrong password exits 1 with message; `logout` removes; `whoami` prints username.
- [ ] Implement; TTY flow uses `@inquirer/prompts` `input`/`password`. Verify, commit.

### Task 4: projects, link, show, todo

**Files:** `src/taiga.ts` (typed endpoints + zod schemas), `src/refs.ts`, `src/commands/{projects,link,show,todo}.ts`; tests `test/link.test.ts`, `test/read.test.ts`.

**Interfaces:**
- `parseRef(text): { prefix: string; ref: number } | undefined`, `findRefs(text, prefixes): string[]`, `resolveRef(cfg, refText): { project: ProjectLink; ref: number }`.
- `IssueDetail` (id, ref, subject, description, status name, type name, priority name, severity name, assigned name, version, created/modified), `loadIssue(client, project, ref): Promise<IssueDetail>` using resolver then `issues/by_ref`.

- [ ] Tests: `link add acme-erp --prefix ERP --ready-status "Ready for test"` writes `.taiga.json`; unknown status refused; duplicate prefix refused; `link remove ERP`; `show ERP-12` prints subject, description, comments, attachment names; `show ERP-13` (user story) errors "only issues"; expired token refreshes once; `todo` lists open issues of all linked projects, `--json` works.
- [ ] Implement; TTY `link` uses `checkbox`/`input`/`select`. Verify, commit.

### Task 5: fetch attachments

**Files:** `src/commands/fetch.ts`, `src/cache.ts`; test `test/fetch.test.ts`.

- [ ] Tests: files land in `$TAIGA_LINK_CACHE_DIR/<host>/<slug>/<ref>/`; second run skips same-size files; video and > 25 MB skipped unless `--all`; filenames sanitized (no `..`, no `/`).
- [ ] Implement, verify, commit.

### Task 6: triage, comment, finish

**Files:** `src/commands/{triage,write}.ts`; test `test/write.test.ts`.

- [ ] Tests: `comment ERP-12 --text t` PATCHes `{comment, version}`; `finish` adds `status` id of `readyStatus`; renamed status errors; `triage --since 2026-10-01 --json` returns `new` (unassigned, created since) and `open` (ref, subject) lists.
- [ ] Implement, verify, commit.

### Task 7: hooks (prompt refs, write confirmation)

**Files:** `src/hooks.ts`, `hooks/hooks.json`; test `test/hooks.test.ts`.

- [ ] Tests: prompt with `ERP-12` injects issue context; `UTF-8`, `ISO-9001`, `ZZZ-1` inject nothing; not logged in gives one line, exit 0; PreToolUse with `taiga finish ERP-12 --text x` returns `permissionDecision: "ask"`; other Bash commands pass silently.
- [ ] Implement, verify, commit.

### Task 8: workgate integration

**Files:** `src/workgate.ts`, `src/commands/{import,wghook}.ts`, `link` registers the hook; test `test/workgate.test.ts` (needs `wg` from `../workgate/bin/wg` or `WG_BIN`).

- [ ] Tests: `import ERP-12` creates item `[ERP-12] ...` with `refs.taiga`, kind/sev mapped; second import refused naming `#id`; `wg-hook` with claim JSON prints summary; with done JSON prints finish instruction; unlinked item prints nothing; `todo` marks `wg #id`; `link add` in a workgate repo adds the hook entry once.
- [ ] Implement, verify, commit.

### Task 9: skill, README, repo

**Files:** `skills/taiga/SKILL.md`, `README.md`, `CLAUDE.md`, `LICENSE`.

- [ ] Write docs; verify; commit; create GitHub repo `alexander-rebello/taiga-link` (public, no push).
