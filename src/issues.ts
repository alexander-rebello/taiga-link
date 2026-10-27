import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { TaigaClient } from './api.js';
import { loadConfig, type LinkConfig } from './config.js';
import { TaigaError } from './errors.js';
import { formatSize, issueUrl, type IssueDocument } from './format.js';
import { cacheDir } from './paths.js';
import { resolveRef, type IssueRef } from './refs.js';
import {
  attachments as listAttachments,
  comments as listComments,
  loadIssue,
  me,
  openIssues,
  projectDetail,
  readyStatusId,
  updateIssue,
  type Attachment,
  type IssueView,
} from './taiga.js';

export interface Session {
  config: LinkConfig;
  client: TaigaClient;
}

export async function openSession(cwd: string): Promise<Session> {
  const { config } = loadConfig(cwd);
  return { config, client: await TaigaClient.open(config.url) };
}

export async function issueDocument(session: Session, ref: IssueRef): Promise<IssueDocument> {
  const issue = await loadIssue(session.client, ref.project, ref.ref);
  const [comments, attachments] = await Promise.all([
    listComments(session.client, issue.id),
    listAttachments(session.client, ref.project, issue.id),
  ]);
  return { issue, url: issueUrl(session.config.url, ref.project.slug, ref.ref), comments, attachments };
}

export async function showIssue(session: Session, refText: string): Promise<IssueDocument> {
  return issueDocument(session, resolveRef(session.config, refText));
}

export async function todoIssues(session: Session, mineOnly: boolean): Promise<IssueView[]> {
  const lists = await Promise.all(session.config.projects.map((p) => openIssues(session.client, p)));
  let all = lists.flat();
  if (mineOnly) {
    const user = await me(session.client);
    all = all.filter((i) => i.assignedToId === user.id);
  }
  return all;
}

export interface TriageResult {
  since: string;
  new: IssueView[];
  open: { key: string; subject: string; status: string }[];
}

export async function triage(session: Session, since: string): Promise<TriageResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new TaigaError('--since must be YYYY-MM-DD.');
  const open = await todoIssues(session, false);
  const fresh = open
    .filter((i) => i.assignedToId === null && i.created.slice(0, 10) >= since)
    .sort((a, b) => b.created.localeCompare(a.created));
  // The list endpoint has no description; triage needs it to judge duplicates and priority.
  const withText = await Promise.all(
    fresh.map(async (i) => {
      const project = session.config.projects.find((p) => i.key.startsWith(`${p.prefix}-`));
      return project === undefined ? i : loadIssue(session.client, project, i.ref);
    }),
  );
  return { since, new: withText, open: open.map((i) => ({ key: i.key, subject: i.subject, status: i.status })) };
}

export async function writeIssue(session: Session, refText: string, text: string, finish: boolean): Promise<IssueView> {
  const comment = text.trim();
  if (comment === '') throw new TaigaError('The comment text is empty.');
  const ref = resolveRef(session.config, refText);
  const issue = await loadIssue(session.client, ref.project, ref.ref);
  const status = finish ? readyStatusId(await projectDetail(session.client, ref.project.id), ref.project) : undefined;
  await updateIssue(session.client, issue, { comment, ...(status === undefined ? {} : { status }) });
  return issue;
}

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv', 'mpg', 'mpeg']);
export const MAX_DEFAULT_BYTES = 25 * 1024 * 1024;

/** Strips any directory part so a crafted attachment name cannot escape the cache directory. */
export function safeFileName(name: string): string {
  const raw = basename(name.replace(/\\/g, '/'));
  let cleaned = '';
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw.charAt(i);
    cleaned += raw.charCodeAt(i) < 32 || '<>:"|?*'.includes(c) ? '_' : c;
  }
  const base = cleaned.trim();
  return base === '' || base === '.' || base === '..' ? 'attachment' : base;
}

export interface FetchEntry {
  name: string;
  path?: string;
  state: 'downloaded' | 'cached' | 'skipped' | 'failed';
  reason?: string;
}

function skipReason(a: Attachment): string | undefined {
  const ext = a.name.split('.').pop()?.toLowerCase() ?? '';
  if (VIDEO_EXTENSIONS.has(ext)) return `video, ${formatSize(a.size)}`;
  if (a.size !== null && a.size > MAX_DEFAULT_BYTES) return `${formatSize(a.size)} > 25 MB`;
  return undefined;
}

export function attachmentDir(session: Session, ref: IssueRef): string {
  const host = new URL(session.config.url).hostname;
  return join(cacheDir(), host, ref.project.slug, String(ref.ref));
}

export async function fetchAttachments(session: Session, refText: string, all: boolean): Promise<{ dir: string; entries: FetchEntry[] }> {
  const ref = resolveRef(session.config, refText);
  const issue = await loadIssue(session.client, ref.project, ref.ref);
  const list = await listAttachments(session.client, ref.project, issue.id);
  const dir = attachmentDir(session, ref);
  const used = new Set<string>();
  const entries: FetchEntry[] = [];
  for (const a of list) {
    let file = safeFileName(a.name);
    if (used.has(file)) file = `${a.id}-${file}`;
    used.add(file);
    const path = join(dir, file);
    const reason = all ? undefined : skipReason(a);
    if (reason !== undefined) {
      entries.push({ name: a.name, state: 'skipped', reason });
      continue;
    }
    if (existsSync(path) && (a.size === null || statSync(path).size === a.size)) {
      entries.push({ name: a.name, path, state: 'cached' });
      continue;
    }
    try {
      await session.client.download(a.url, path);
      entries.push({ name: a.name, path, state: 'downloaded' });
    } catch (error) {
      entries.push({ name: a.name, state: 'failed', reason: (error as Error).message });
    }
  }
  return { dir, entries };
}
