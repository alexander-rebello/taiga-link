# taiga-link design

## Intent

Make Taiga issues usable from Claude Code without copy and paste: log in once, link the Taiga projects that belong to the current repository, read issues with their comments and attachments, triage new issues, and hand finished work back to Taiga as a comment plus the "ready for test" status. Other people test in Taiga afterwards.

Published the same way as workgate: an npm package (`taiga-link`, CLI `taiga`) that is also a Claude Code plugin (marketplace in the repo, `bin/taiga` committed as an esbuild bundle).

## Goals

- `taiga login`: URL, username, password asked in a terminal (hidden password). Only tokens are stored, in the macOS Keychain (0600 file elsewhere), keyed by instance URL. The password is never stored and never passes through the Claude conversation.
- `taiga link`: choose which Taiga projects belong to this repository. Stored in a committed `.taiga.json` (no secrets): instance URL, and per project id, slug, name, prefix and ready-to-test status. Re-run (or `link add|remove`) to change it.
- References are always `<PREFIX>-<ref>` (for example `ERP-123`). Taiga refs are per project, so the prefix is mandatory. Bare `#42` or `42` is always a workgate id.
- Read: `taiga todo` (open issues of the linked projects), `taiga show ERP-123` (issue, comments, attachment list, linked workgate item), `taiga fetch ERP-123` (attachments into `~/.cache/taiga-link/<host>/<slug>/<ref>/`, outside the repo).
- Triage: `taiga triage` gathers new open issues plus the titles of all open issues; the skill has Claude summarize, flag likely duplicates and suggest priorities. Read-only.
- Write: `taiga comment ERP-123 --text` and `taiga finish ERP-123 --text` (comment plus switch to the project's ready-to-test status). Nothing else is ever written to Taiga.
- Prompt hook: a registered `ERP-123` in a user prompt gets the issue injected into the context.
- Workgate integration: in a repository with `.workgate/config.json`, Taiga issues become workgate items (`taiga import ERP-123`) and workgate is the only todo list.

## Non-goals

- Status changes other than ready-to-test; no status change and no assignment on claim or pick.
- Statusline segment, creating Taiga issues from Claude, commit-message status tags.
- A local todo list file. Without workgate, Taiga itself is the list; in-session steps use Claude's built-in task list.
- User stories, tasks and epics (v1 handles issues; a ref that resolves to another type gets a clear error).

## Anti-goals

- Passwords or tokens in the transcript, the repo or process arguments.
- Writes to Taiga without the user seeing the exact text first.
- Mixing up Taiga refs and workgate ids.
- Attachments landing in the repository.

## Decisions

### Shape: CLI plus skill plus hooks, no MCP server

A skill costs no context until used, the CLI is usable by humans, and it matches workgate's stack and release flow (TypeScript strict, ESM, Node >= 20, pnpm, esbuild bundle, vitest against the built binary, eslint strictTypeChecked, CI and OIDC publish workflows).

### Authentication

`POST /api/v1/auth {type: "normal", username, password}` returns `auth_token` and `refresh`. Requests use `Authorization: Bearer`. On 401 the CLI calls `POST /api/v1/auth/refresh` once and stores the new pair. If refresh fails, the user is told to run `taiga login` again.

`taiga login` needs a TTY. For scripts and tests it accepts `--url`, `--username` and `--password-stdin`. The skill never asks for the password in chat; it tells the user to run `taiga login` in a terminal.

Storage: macOS `security` driven through `security -i` with commands on stdin, so the secret never appears in process arguments. Value is base64 JSON `{authToken, refresh, username}`. Other platforms (and `TAIGA_LINK_STORE=file`): `~/.config/taiga-link/credentials.json`, mode 0600. `TAIGA_LINK_CONFIG_DIR` overrides the directory.

### `.taiga.json`

```json
{
  "version": 1,
  "url": "https://taiga.example.com",
  "projects": [
    { "id": 12, "slug": "acme-erp", "name": "ERP", "prefix": "ERP", "readyStatus": "Ready for test" }
  ]
}
```

Found at the git toplevel of the current directory (workgate worktrees carry their own committed copy). Prefixes: 2 to 10 chars, `[A-Z][A-Z0-9]+`, unique. `readyStatus` is stored by name and resolved against the project's issue statuses on each `finish`; a renamed status gives a clear error.

`taiga link` (TTY): checkbox list of the user's projects, then per project a prefix (default: uppercased slug initials or first word) and a ready status picked from that project's statuses. Non-interactive: `taiga projects [--json]`, `taiga link add <slug> --prefix P --ready-status S`, `taiga link remove <prefix>`, `taiga link list`.

In a workgate repository, `taiga link` also adds the event hook to `.workgate/config.json`. Both files are left uncommitted; the user commits them (in a workgate repo through a `[quick]` prompt or an item).

### Taiga API used

- `GET /users/me`, `GET /projects?member=<id>`, `GET /projects/<id>` (statuses, types, priorities, severities).
- `GET /resolver?project=<slug>&ref=<n>` to tell issues from other types.
- `GET /issues?project=<id>&status__is_closed=false`, `GET /issues/<id>` (after the resolver), `GET /projects/by_slug?slug=<slug>`.
- `GET /history/issue/<id>?type=comment` (deleted comments skipped).
- `GET /issues/attachments?project=<id>&object_id=<id>`; files downloaded from the returned `url` with the bearer header.
- `PATCH /issues/<id> {comment, status?, version}`.

All list requests send `x-disable-pagination: True`.

### Attachments

Downloaded on demand by `taiga fetch` to the cache directory (`TAIGA_LINK_CACHE_DIR` overrides). Files over 25 MB and `video/*` are listed but skipped unless `--all`. Already downloaded files with matching size are not fetched again. Output lists the local paths so Claude reads them with Read (images and PDFs work natively).

### Writes and confirmation

`comment` and `finish` take the text as `--text "<...>"` on the command line on purpose: a PreToolUse hook on Bash returns `permissionDecision: "ask"` for any `taiga comment` or `taiga finish`, so Claude Code shows the user the exact command, including the text, and the user approves it even in auto mode. The skill tells Claude to show the draft first anyway. This is a mistake guard, not a security boundary.

### Prompt hook

UserPromptSubmit: find `\b([A-Z][A-Z0-9]{1,9})-(\d+)\b`, keep matches whose prefix is in `.taiga.json`, at most 5, fetch each (8 s total budget) and inject subject, status, type, priority, description and attachment names as additional context. Not logged in or network errors produce one short context line, never a blocked prompt.

### Workgate integration

Needs two changes in workgate (separate branch in the workgate repo, done first):

1. Items get an optional `refs` map (`refs: { taiga: ERP-123 }`), set with `wg add --ref taiga=ERP-123` (repeatable).
2. Config gets `hooks: [{ on: [events], command }]`. Events: `add`, `claim`, `block`, `done`, `drop`. After a successful operation the command runs through the shell in the main checkout with `{event, item}` JSON on stdin; its stdout is printed after the command's own output (to stderr with `--json`). A failing hook prints a warning and never changes the result of the operation. 30 s timeout.

taiga-link side:

- `taiga import ERP-123`: refuses if an item with `refs.taiga == ERP-123` exists; otherwise `wg add "[ERP-123] <subject>" --kind <bug|feature> [--sev] --ref taiga=ERP-123` with the description as body plus a plan section. Kind: issue type name matching /bug/i is `bug`, everything else `feature`. Severity: Critical S1, Important S2, Normal S3, Minor and Wishlist S4, unknown none.
- `taiga wg-hook` (the registered command): on `claim` of a linked item prints the issue summary and the `taiga fetch` hint; on `done` prints the instruction to draft a closing comment from the outcome in the issue's language, show it, and run `taiga finish ERP-123 --text "..."`. Other events and unlinked items print nothing.
- `taiga todo` in a workgate repo marks issues that already have an item (`wg #42`).

Without workgate the skill uses `taiga todo` as the list and `taiga finish` when done.

### Plugin layout

```
.claude-plugin/plugin.json, marketplace.json
bin/taiga                 committed bundle
hooks/hooks.json          UserPromptSubmit (refs), PreToolUse Bash (write confirmation)
skills/taiga/SKILL.md     /taiga front end: login, link, todo, show, fetch, triage, import, finish
src/                      cli, config, credentials, api, refs, attachments, workgate, hooks
test/                     vitest against bin/taiga with a local mock Taiga HTTP server
```

## Left to the builder

- Exact output formatting of the list and show commands.
- Prompt library for the TTY flows (bundled, no runtime dependencies).
- Default prefix heuristic.

## Calls made without the owner (check these)

- Comment drafts are written in the issue's language.
- Workgate refs are a generic `refs` map rather than a Taiga-specific field.
- Workgate event hooks are generic (any command, five events), not Taiga-specific.
- `.taiga.json` and the workgate config change are left uncommitted by `taiga link`.
- Attachment size limit 25 MB, videos skipped by default.
- v1 supports issues only.
