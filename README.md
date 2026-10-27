# taiga-link

Taiga issues in Claude Code. Link the Taiga projects that belong to a repository, read issues with comments and attachments, triage new issues, and hand finished work back to Taiga as a comment plus the "ready for test" status. Integrates with [workgate](https://github.com/alexander-rebello/workgate).

- Login happens in your terminal. Only tokens are stored (macOS Keychain, or a 0600 file elsewhere); the password never enters the Claude conversation.
- Issues are referenced as `<PREFIX>-<number>` (`ERP-123`). Taiga numbers are per project, so the prefix is mandatory; bare `#42` stays a workgate id.
- The only writes to Taiga are comments and the switch to your ready-to-test status, and Claude Code asks you to confirm each one.

## Install

Claude Code plugin (puts `taiga` on the PATH, adds the hooks and the `/taiga` skill):

```
/plugin marketplace add alexander-rebello/taiga-link
/plugin install taiga-link@taiga-link
```

CLI only (npm):

```sh
npm install --global taiga-link
```

## Setup

```sh
taiga login          # URL, username, password (hidden); run it in a terminal
taiga link           # tick projects, choose a prefix and the ready-to-test status for each
```

`taiga link` writes `.taiga.json` at the repository root. Commit it so the team shares the link:

```json
{
  "version": 1,
  "url": "https://taiga.example.com",
  "projects": [
    { "id": 12, "slug": "acme-erp", "name": "ERP", "prefix": "ERP", "readyStatus": "Ready for test" }
  ]
}
```

## Commands

| Command | Purpose |
| --- | --- |
| `taiga login [--url u --username n --password-stdin]` | log in (interactive, or scripted with the password on stdin) |
| `taiga logout`, `taiga whoami` | forget tokens, show the user |
| `taiga projects [--json]`, `taiga statuses <slug>` | your projects, a project's issue statuses |
| `taiga link`, `taiga link add <slug> --prefix P --ready-status S`, `taiga link remove <P>`, `taiga link list` | manage `.taiga.json` |
| `taiga todo [--mine] [--json]` | open issues of the linked projects |
| `taiga show <REF> [--json]` | issue, comments, attachment names |
| `taiga fetch <REF> [--all]` | download attachments to `~/.cache/taiga-link/<host>/<project>/<ref>/` and print the paths; videos and files over 25 MB need `--all` |
| `taiga triage [--since YYYY-MM-DD] [--json]` | new unassigned issues plus all open titles, for duplicate and priority review (read-only) |
| `taiga comment <REF> --text t` | add a comment |
| `taiga finish <REF> --text t` | comment and move the issue to the ready-to-test status |
| `taiga import <REF>` | create a workgate item for the issue |

## In Claude Code

- `/taiga` shows open issues and walks through reading, triage and the handoff.
- Mention a linked reference such as `ERP-123` in a prompt and the issue is added to the context. Unlinked look-alikes (`UTF-8`, `ISO-9001`) are ignored.
- `taiga comment` and `taiga finish` always trigger a permission prompt showing the full text, also in auto mode. This is a guard against mistakes, not a security boundary.

## With workgate

In a repository with `.workgate/config.json`, workgate is the todo list:

- `taiga import ERP-123` runs `wg add "[ERP-123] <subject>" --ref taiga=ERP-123` with the description as body. Issue type "Bug" becomes `bug`, everything else `feature`; severity Critical/Important/Normal/Minor and Wishlist maps to S1 to S4. Importing the same issue twice is refused.
- `taiga link` registers `taiga wg-hook` in the workgate config for `claim` and `done`. On claim it prints the issue; on done it asks Claude to draft the closing comment and run `taiga finish` after your approval.
- `taiga todo` and `taiga show` show the workgate id of imported issues.

Requires a workgate version with `--ref` and event hooks.

## Environment

| Variable | Effect |
| --- | --- |
| `TAIGA_LINK_STORE` | `keychain` or `file` (default: keychain on macOS) |
| `TAIGA_LINK_CONFIG_DIR` | config and credentials directory (default `~/.config/taiga-link`) |
| `TAIGA_LINK_CACHE_DIR` | attachment cache (default `~/.cache/taiga-link`) |
| `WG_BIN` | workgate binary (default `wg`) |

## Development

```sh
pnpm install
pnpm run verify   # typecheck, lint, build, tests
```

Tests run the built `bin/taiga` against a mock Taiga server. The workgate tests use `../workgate/bin/wg` when present, otherwise the npm package, and are skipped when that version has no `--ref`.

`bin/taiga` is a bundled build artifact and is committed because the plugin runs from the git checkout; CI fails when it is stale.
