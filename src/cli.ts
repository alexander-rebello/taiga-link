import { relative } from 'node:path';
import { Command, Option } from 'commander';
import { TaigaClient, defaultUrl, login, setDefaultUrl } from './api.js';
import { findConfigFile, normalizeUrl, projectRoot, readConfig, saveConfig } from './config.js';
import { deleteCredentials, setCredentials } from './credentials.js';
import { TaigaError } from './errors.js';
import { formatIssue, issueLine, issueUrl } from './format.js';
import { HOOK_NAMES, runHook, type HookName } from './hooks.js';
import { fetchAttachments, openSession, showIssue, todoIssues, triage, writeIssue, type Session } from './issues.js';
import { addLink, defaultPrefix, linkTarget, removeLink, upsertProject } from './link.js';
import { resolveRef } from './refs.js';
import { readStdin } from './stdin.js';
import { loadIssue, me, myProjects, projectBySlug, projectDetail, type IssueView } from './taiga.js';
import { WgEventSchema, changedPaths, importIssue, itemsByKey, registerHook, usesWorkgate, type WgItem } from './workgate.js';

declare const __TAIGA_VERSION__: string;

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

function note(text: string): void {
  process.stderr.write(`${text}\n`);
}

function cwd(): string {
  return process.cwd();
}

function instanceUrl(urlOption: string | undefined): string {
  if (urlOption !== undefined) return normalizeUrl(urlOption);
  const file = findConfigFile(cwd());
  if (file !== undefined) return readConfig(file).url;
  const url = defaultUrl();
  if (url === undefined) throw new TaigaError('No Taiga instance known. Run "taiga login" first.');
  return url;
}

function requireTty(what: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new TaigaError(`"${what}" needs an interactive terminal. Run it in a terminal window, or use the non-interactive options (see --help).`);
  }
}

/** Workgate ids for Taiga keys; empty outside workgate repos or when wg is unavailable. */
async function workgateMap(): Promise<Map<string, WgItem>> {
  if (!usesWorkgate(cwd())) return new Map();
  try {
    return await itemsByKey(cwd());
  } catch (error) {
    note(`workgate: ${(error as Error).message}`);
    return new Map();
  }
}

function json(value: unknown): void {
  print(JSON.stringify(value, null, 2));
}

async function afterLinkChange(file: string): Promise<void> {
  const root = projectRoot(cwd());
  const paths = [relative(root, file)];
  if (usesWorkgate(cwd())) {
    if (registerHook(cwd())) print('Registered "taiga wg-hook" for claim and done in .workgate/config.json.');
    paths.push('.workgate/config.json');
  }
  const changed = await changedPaths(root, paths);
  if (changed.length > 0) print(`Uncommitted: ${changed.join(', ')}. Commit them so the team shares the link.`);
}

const program = new Command();
program
  .name('taiga')
  .version(__TAIGA_VERSION__)
  .description('Taiga issues for Claude Code: linked projects, issues, attachments, triage and ready-for-test handoff.')
  .showHelpAfterError();

program
  .command('login')
  .description('Log in to a Taiga instance (interactive; stores tokens, never the password)')
  .option('--url <url>', 'instance URL, for example https://taiga.example.com')
  .option('--username <name>', 'username or email')
  .option('--password-stdin', 'read the password from stdin (for scripts)')
  .action(async (opts: { url?: string; username?: string; passwordStdin?: boolean }) => {
    let url = opts.url;
    let username = opts.username;
    let password: string;
    if (opts.passwordStdin === true) {
      if (url === undefined || username === undefined) throw new TaigaError('--password-stdin needs --url and --username.');
      password = (await readStdin()).replace(/\r?\n$/, '');
    } else {
      requireTty('taiga login');
      const { input, password: passwordPrompt } = await import('@inquirer/prompts');
      const fallback = defaultUrl();
      url ??= await input({ message: 'Taiga URL', ...(fallback === undefined ? {} : { default: fallback }), required: true });
      username ??= await input({ message: 'Username or email', required: true });
      password = await passwordPrompt({ message: 'Password', mask: '*' });
    }
    if (password === '') throw new TaigaError('Empty password.');
    const base = normalizeUrl(url);
    const credentials = await login(base, username, password);
    await setCredentials(base, credentials);
    setDefaultUrl(base);
    print(`Logged in to ${base} as ${credentials.username}.`);
  });

program
  .command('logout')
  .description('Forget the stored tokens for the instance')
  .option('--url <url>', 'instance URL (default: linked or last used)')
  .action(async (opts: { url?: string }) => {
    const url = instanceUrl(opts.url);
    const removed = await deleteCredentials(url);
    print(removed ? `Logged out of ${url}.` : `Was not logged in to ${url}.`);
  });

program
  .command('whoami')
  .description('Show the logged-in user')
  .option('--url <url>', 'instance URL (default: linked or last used)')
  .action(async (opts: { url?: string }) => {
    const url = instanceUrl(opts.url);
    const user = await me(await TaigaClient.open(url));
    print(`${user.username} @ ${url}`);
  });

program
  .command('projects')
  .description('List the Taiga projects you are a member of')
  .option('--url <url>', 'instance URL (default: linked or last used)')
  .option('--json', 'machine-readable output')
  .action(async (opts: { url?: string; json?: boolean }) => {
    const client = await TaigaClient.open(instanceUrl(opts.url));
    const projects = await myProjects(client);
    if (opts.json === true) {
      json(projects);
      return;
    }
    for (const p of projects) print(`${p.slug.padEnd(28)} ${p.name}`);
  });

program
  .command('statuses')
  .description('List the issue statuses of a project (to choose the ready-to-test status)')
  .argument('<slug>', 'project slug, see "taiga projects"')
  .option('--url <url>', 'instance URL (default: linked or last used)')
  .action(async (slug: string, opts: { url?: string }) => {
    const detail = await projectBySlug(await TaigaClient.open(instanceUrl(opts.url)), slug);
    for (const s of detail.issue_statuses) print(s.is_closed ? `${s.name} (closed)` : s.name);
  });

const link = program.command('link').description('Choose which Taiga projects belong to this repository (.taiga.json)');

link
  .command('pick', { isDefault: true })
  .description('Interactive: tick projects, then set prefix and ready-to-test status for each')
  .option('--url <url>', 'instance URL (default: linked or last used)')
  .action(async (opts: { url?: string }) => {
    requireTty('taiga link');
    const { checkbox, input, select } = await import('@inquirer/prompts');
    const target = linkTarget(cwd(), opts.url);
    const client = await TaigaClient.open(target.config.url);
    const projects = await myProjects(client);
    const linkedIds = new Set(target.config.projects.map((p) => p.id));
    const chosen = await checkbox({
      message: `Projects for ${projectRoot(cwd())}`,
      choices: projects.map((p) => ({ name: `${p.name} (${p.slug})`, value: p.id, checked: linkedIds.has(p.id) })),
      pageSize: 15,
    });
    let config = { ...target.config, projects: target.config.projects.filter((p) => chosen.includes(p.id)) };
    for (const id of chosen) {
      const detail = await projectDetail(client, id);
      const current = config.projects.find((p) => p.id === id);
      const taken = config.projects.filter((p) => p.id !== id).map((p) => p.prefix);
      const prefix = await input({
        message: `Prefix for ${detail.name} (refs look like PREFIX-123)`,
        default: current?.prefix ?? defaultPrefix(detail.slug, taken),
        validate: (v) => /^[A-Za-z][A-Za-z0-9]{1,9}$/.test(v.trim()) && !taken.includes(v.trim().toUpperCase()) ? true : '2 to 10 letters or digits, starting with a letter, not used by another project',
      });
      const guess = current?.readyStatus ?? detail.issue_statuses.find((s) => /ready.*test/i.test(s.name))?.name;
      const readyStatus = await select({
        message: `Status for "ready to test" in ${detail.name}`,
        choices: detail.issue_statuses.map((s) => ({ name: s.name, value: s.name })),
        ...(guess === undefined ? {} : { default: guess }),
      });
      config = upsertProject(config, detail, prefix, readyStatus);
    }
    saveConfig(target.file, config);
    print(`Linked ${config.projects.map((p) => `${p.prefix} (${p.name})`).join(', ') || 'no projects'} in ${target.file}.`);
    await afterLinkChange(target.file);
  });

link
  .command('add')
  .description('Link one project (non-interactive)')
  .argument('<slug>', 'project slug, see "taiga projects"')
  .requiredOption('--prefix <prefix>', 'reference prefix, for example ERP')
  .requiredOption('--ready-status <name>', 'issue status that means ready to test')
  .option('--url <url>', 'instance URL for a new .taiga.json (default: last login)')
  .action(async (slug: string, opts: { prefix: string; readyStatus: string; url?: string }) => {
    const result = await addLink(cwd(), slug, opts.prefix, opts.readyStatus, opts.url);
    print(`Linked ${result.link.name} as ${result.link.prefix} in ${result.file}.`);
    await afterLinkChange(result.file);
  });

link
  .command('remove')
  .description('Unlink a project')
  .argument('<prefix>')
  .action(async (prefix: string) => {
    const result = removeLink(cwd(), prefix);
    print(`Unlinked ${result.removed.name} (${result.removed.prefix}).`);
    await afterLinkChange(result.file);
  });

link
  .command('list')
  .description('Show the linked projects')
  .option('--json', 'machine-readable output')
  .action((opts: { json?: boolean }) => {
    const file = findConfigFile(cwd());
    if (file === undefined) throw new TaigaError('Nothing linked here. Run "taiga link".');
    const config = readConfig(file);
    if (opts.json === true) {
      json(config);
      return;
    }
    print(`${config.url} (${file})`);
    for (const p of config.projects) print(`${p.prefix.padEnd(10)} ${p.name} (${p.slug}), ready status: ${p.readyStatus}`);
  });

function todoLine(issue: IssueView, items: Map<string, WgItem>): string {
  const item = items.get(issue.key);
  return item === undefined ? issueLine(issue) : `${issueLine(issue)}  wg #${item.id} ${item.status}`;
}

program
  .command('todo')
  .description('Open issues of the linked projects')
  .option('--mine', 'only issues assigned to me')
  .option('--json', 'machine-readable output')
  .action(async (opts: { mine?: boolean; json?: boolean }) => {
    const session = await openSession(cwd());
    const [issues, items] = await Promise.all([todoIssues(session, opts.mine === true), workgateMap()]);
    if (opts.json === true) {
      json(issues.map((i) => ({ ...i, workgate: items.get(i.key)?.id ?? null })));
      return;
    }
    if (issues.length === 0) print('No open issues.');
    for (const issue of issues) print(todoLine(issue, items));
  });

program
  .command('show')
  .description('Show an issue with comments and attachment names')
  .argument('<ref>', 'for example ERP-123')
  .option('--json', 'machine-readable output')
  .action(async (ref: string, opts: { json?: boolean }) => {
    const session = await openSession(cwd());
    const doc = await showIssue(session, ref);
    doc.workgateId = (await workgateMap()).get(doc.issue.key)?.id;
    if (opts.json === true) json({ ...doc.issue, url: doc.url, comments: doc.comments, attachments: doc.attachments, workgate: doc.workgateId ?? null });
    else print(formatIssue(doc));
  });

program
  .command('fetch')
  .description('Download attachments to the local cache (outside the repository) and print their paths')
  .argument('<ref>', 'for example ERP-123')
  .option('--all', 'include videos and files over 25 MB')
  .action(async (ref: string, opts: { all?: boolean }) => {
    const session = await openSession(cwd());
    const { dir, entries } = await fetchAttachments(session, ref, opts.all === true);
    if (entries.length === 0) {
      print('No attachments.');
      return;
    }
    print(`Attachments in ${dir}:`);
    let failed = false;
    for (const e of entries) {
      if (e.state === 'failed') {
        failed = true;
        note(`failed ${e.name}: ${e.reason ?? ''}`);
      } else if (e.state === 'skipped') print(`skipped ${e.name} (${e.reason ?? ''}), use --all to download`);
      else print(`${e.path ?? ''}${e.state === 'cached' ? ' (cached)' : ''}`);
    }
    if (failed) process.exitCode = 1;
  });

program
  .command('triage')
  .description('New unassigned issues since a date plus all open titles, for duplicate and priority review (read-only)')
  .option('--since <date>', 'YYYY-MM-DD (default: 14 days ago)')
  .option('--json', 'machine-readable output')
  .action(async (opts: { since?: string; json?: boolean }) => {
    const since = opts.since ?? new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
    const result = await triage(await openSession(cwd()), since);
    if (opts.json === true) {
      json(result);
      return;
    }
    print(`New since ${since} (${result.new.length}):`);
    for (const i of result.new) {
      print(`\n${i.key} ${i.subject}\n  ${i.type}, priority ${i.priority}, severity ${i.severity}, created ${i.created.slice(0, 10)}`);
      if (i.description.trim() !== '') print(`  ${i.description.trim().slice(0, 600).replace(/\n/g, '\n  ')}`);
    }
    print(`\nAll open (${result.open.length}):`);
    for (const i of result.open) print(`${i.key.padEnd(9)} [${i.status}] ${i.subject}`);
  });

async function write(ref: string, text: string, finish: boolean): Promise<void> {
  const session: Session = await openSession(cwd());
  const issue = await writeIssue(session, ref, text, finish);
  const project = resolveRef(session.config, ref).project;
  print(finish ? `Commented on ${issue.key}; ${issue.key} is now "${project.readyStatus}".` : `Commented on ${issue.key}.`);
}

program
  .command('comment')
  .description('Add a comment to an issue (asks for confirmation inside Claude Code)')
  .argument('<ref>', 'for example ERP-123')
  .requiredOption('--text <text>', 'comment text (Markdown)')
  .action(async (ref: string, opts: { text: string }) => {
    await write(ref, opts.text, false);
  });

program
  .command('finish')
  .description('Comment and move the issue to the linked ready-to-test status')
  .argument('<ref>', 'for example ERP-123')
  .requiredOption('--text <text>', 'closing comment: what changed and how to test it')
  .action(async (ref: string, opts: { text: string }) => {
    await write(ref, opts.text, true);
  });

program
  .command('import')
  .description('Create a workgate item for an issue (workgate repositories only)')
  .argument('<ref>', 'for example ERP-123')
  .action(async (ref: string) => {
    if (!usesWorkgate(cwd())) throw new TaigaError('This repository does not use workgate. Use "taiga todo" as the list instead.');
    const session = await openSession(cwd());
    const parsed = resolveRef(session.config, ref);
    const issue = await loadIssue(session.client, parsed.project, parsed.ref);
    const item = await importIssue(cwd(), issue, issueUrl(session.config.url, parsed.project.slug, parsed.ref));
    print(`Created workgate #${item.id} for ${issue.key}: ${item.title}`);
  });

program
  .command('wg-hook')
  .description('Workgate event hook (registered by "taiga link"; reads the event JSON from stdin)')
  .action(async () => {
    try {
      const event = WgEventSchema.parse(JSON.parse(await readStdin()));
      const key = event.item.refs?.taiga;
      if (key === undefined) return;
      if (event.event === 'done') {
        print(
          [
            `taiga-link: workgate #${event.item.id} is linked to ${key}.`,
            `Draft a short closing comment for the testers from the outcome (what changed, how to test it), in the language of the issue.`,
            `Show the draft to the user, then run: taiga finish ${key} --text "<comment>"`,
            `That posts the comment and sets the ready-to-test status. Do not run it without the user's approval of the text.`,
          ].join('\n'),
        );
        return;
      }
      if (event.event === 'claim') {
        const session = await openSession(cwd());
        const doc = await showIssue(session, key);
        print(`taiga-link: workgate #${event.item.id} is ${key}.\n\n${formatIssue(doc)}`);
      }
    } catch (error) {
      print(`taiga-link: ${(error as Error).message}`);
    }
  });

program
  .command('hook')
  .description('Claude Code hook entry point (reads hook JSON from stdin)')
  .addOption(new Option('--debug', 'print errors').hideHelp())
  .argument('<name>', HOOK_NAMES.join(' | '))
  .action(async (name: string, opts: { debug?: boolean }) => {
    if (!HOOK_NAMES.includes(name as HookName)) throw new TaigaError(`Unknown hook "${name}".`);
    try {
      const out = await runHook(name as HookName, await readStdin());
      if (out !== undefined) print(out);
    } catch (error) {
      // A hook must never block the session.
      if (opts.debug === true) note(`taiga-link hook ${name} failed: ${(error as Error).message}`);
    }
  });

program.parseAsync().catch((error: unknown) => {
  if (error instanceof TaigaError) {
    note(error.message);
    process.exitCode = error.exitCode;
    return;
  }
  if (error instanceof Error && error.name === 'ExitPromptError') {
    process.exitCode = 130;
    return;
  }
  note(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
