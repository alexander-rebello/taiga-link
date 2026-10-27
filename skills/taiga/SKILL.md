---
name: taiga
description: Taiga issues for this repository (the `taiga` CLI from taiga-link). Use on /taiga, or when the user mentions Taiga, a linked issue reference such as ERP-123, wants to see open tickets, triage new ones, read an issue's attachments, or hand finished work back to Taiga for testing.
---

# /taiga

Front end for the `taiga` CLI. Everything goes through the CLI; never call the Taiga API yourself and never edit `.taiga.json` by hand.

## Rules

- Never ask for, accept or repeat a Taiga password in the conversation. Login happens only in the user's own terminal.
- References are `<PREFIX>-<number>` (for example `ERP-123`). A bare number or `#42` is a workgate id, never a Taiga issue.
- The only writes are `taiga comment` and `taiga finish`. Show the exact text to the user first and run the command only after they approve it; Claude Code will also ask them to confirm the command. Never change any other status or assignee.
- Comments go to the testers and the rest of the team: plain, short, in the language of the issue, no internal file paths or code dumps.

## Arguments

- none or `todo`: the overview (step 2).
- `login`, `link`: setup (step 1).
- `<REF>`: show that issue (step 3).
- `triage`: step 4.
- `finish <REF>`: step 5.

## 1. Setup

If `command -v taiga` fails, say the plugin's `bin` is not on PATH and stop.

- Login: run `command -v taiga` and tell the user to run `<that path> login` in a separate terminal window (it asks for URL, username and password with hidden input). Do not try to run it yourself. Afterwards confirm with `taiga whoami`.
- Link: `taiga link` is interactive, so the user runs it in their terminal too. Alternatively do it conversationally: run `taiga projects`, ask the user which projects belong to this repository and which prefix each gets, show each project's statuses with `taiga statuses <slug>` and ask which one means ready to test, then run `taiga link add <slug> --prefix <P> --ready-status "<status>"` per project. `taiga link list` shows the result.
- Linking leaves `.taiga.json` (and, in a workgate repository, `.workgate/config.json`) uncommitted. Tell the user; in a workgate repository they commit through a `[quick]` prompt or an item.

## 2. Overview

Run `taiga todo --json`. Group: assigned to the user, unassigned, assigned to others; at most 5 rows per group (key, subject, status, priority). Mark issues that already have a workgate item (`workgate` field). Offer to show or start one.

## 3. Read an issue

Run `taiga show <REF>`. If it lists attachments, run `taiga fetch <REF>` and Read the printed paths (images and PDFs directly; text files as needed). Skipped videos or large files: mention them and offer `taiga fetch <REF> --all`. Attachments live in a cache outside the repository; never copy them into it.

## 4. Triage (read-only)

Run `taiga triage --json` (add `--since YYYY-MM-DD` if the user names a period). For each issue in `new`:

- one-line summary,
- likely duplicates among `open` (key and why),
- suggested priority with a one-line reason,
- missing information the reporter should add.

Present this as suggestions. Do not comment, assign or change anything in Taiga.

## 5. Working on an issue

With workgate (the repository has `.workgate/config.json`): workgate is the only todo list.

1. `taiga import <REF>` creates the item (`[REF] subject`, linked through `refs.taiga`). It refuses duplicates and names the existing id.
2. Continue with the workgate flow (`wg claim <id>` and so on). On claim the hook prints the issue; fetch attachments as in step 3.
3. After `wg done`, the hook asks for the handoff: draft the closing comment, show it, then `taiga finish <REF> --text "<comment>"`.

Without workgate: `taiga todo` is the list; use the built-in task list for steps within the session. When done, draft the comment, show it, then run `taiga finish <REF> --text "<comment>"`.

A closing comment states what changed and how to test it, in two to five sentences.
