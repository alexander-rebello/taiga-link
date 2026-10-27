import { z } from 'zod';
import type { TaigaClient } from './api.js';
import type { ProjectLink } from './config.js';
import { TaigaError } from './errors.js';

const MeSchema = z.object({ id: z.number().int(), username: z.string() });

const ProjectSummarySchema = z.object({ id: z.number().int(), name: z.string(), slug: z.string() });
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

const NamedSchema = z.object({ id: z.number().int(), name: z.string() });
const StatusSchema = NamedSchema.extend({ is_closed: z.boolean() });

const ProjectDetailSchema = ProjectSummarySchema.extend({
  issue_statuses: z.array(StatusSchema),
  issue_types: z.array(NamedSchema),
  priorities: z.array(NamedSchema),
  severities: z.array(NamedSchema),
});
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;

const IssueSchema = z.object({
  id: z.number().int(),
  ref: z.number().int(),
  project: z.number().int(),
  subject: z.string(),
  status: z.number().int(),
  type: z.number().int().nullable(),
  priority: z.number().int().nullable(),
  severity: z.number().int().nullable(),
  assigned_to: z.number().int().nullable(),
  assigned_to_extra_info: z.object({ full_name_display: z.string() }).nullable().optional(),
  created_date: z.string(),
  modified_date: z.string(),
  version: z.number().int(),
});

const IssueDetailSchema = IssueSchema.extend({ description: z.string().nullable() });

const CommentSchema = z.object({
  comment: z.string(),
  user: z.object({ name: z.string().optional(), username: z.string().optional() }).nullable(),
  created_at: z.string(),
  delete_comment_date: z.string().nullable().optional(),
});

const AttachmentSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  size: z.number().int().nullable(),
  url: z.string(),
  is_deprecated: z.boolean().optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

const ResolverSchema = z.object({
  project: z.number().int(),
  issue: z.number().int().optional(),
  us: z.number().int().optional(),
  task: z.number().int().optional(),
  epic: z.number().int().optional(),
  wikipage: z.number().int().optional(),
});

export interface IssueView {
  id: number;
  ref: number;
  key: string;
  subject: string;
  description: string;
  status: string;
  closed: boolean;
  type: string;
  priority: string;
  severity: string;
  assignedTo: string | null;
  assignedToId: number | null;
  created: string;
  modified: string;
  version: number;
}

export interface CommentView {
  author: string;
  created: string;
  text: string;
}

export function me(client: TaigaClient): Promise<z.infer<typeof MeSchema>> {
  return client.get('/users/me', MeSchema);
}

export async function myProjects(client: TaigaClient): Promise<ProjectSummary[]> {
  const user = await me(client);
  const projects = await client.get(`/projects?member=${user.id}`, z.array(ProjectSummarySchema));
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

/** Per-process cache: every command needs the project's status, type and priority names at most once. */
const projectCache = new Map<number, Promise<ProjectDetail>>();

export function projectDetail(client: TaigaClient, id: number): Promise<ProjectDetail> {
  let cached = projectCache.get(id);
  if (cached === undefined) {
    cached = client.get(`/projects/${id}`, ProjectDetailSchema);
    projectCache.set(id, cached);
  }
  return cached;
}

export async function projectBySlug(client: TaigaClient, slug: string): Promise<ProjectDetail> {
  const summary = await client.get(`/projects/by_slug?slug=${encodeURIComponent(slug)}`, ProjectSummarySchema);
  return projectDetail(client, summary.id);
}

function nameOf(list: readonly { id: number; name: string }[], id: number | null): string {
  if (id === null) return '-';
  return list.find((x) => x.id === id)?.name ?? `#${id}`;
}

function toView(link: ProjectLink, detail: ProjectDetail, issue: z.infer<typeof IssueSchema>, description: string): IssueView {
  const status = detail.issue_statuses.find((s) => s.id === issue.status);
  return {
    id: issue.id,
    ref: issue.ref,
    key: `${link.prefix}-${issue.ref}`,
    subject: issue.subject,
    description,
    status: status?.name ?? `#${issue.status}`,
    closed: status?.is_closed ?? false,
    type: nameOf(detail.issue_types, issue.type),
    priority: nameOf(detail.priorities, issue.priority),
    severity: nameOf(detail.severities, issue.severity),
    assignedTo: issue.assigned_to === null ? null : (issue.assigned_to_extra_info?.full_name_display ?? `#${issue.assigned_to}`),
    assignedToId: issue.assigned_to,
    created: issue.created_date,
    modified: issue.modified_date,
    version: issue.version,
  };
}

export async function loadIssue(client: TaigaClient, link: ProjectLink, ref: number): Promise<IssueView> {
  const resolved = await client.get(
    `/resolver?project=${encodeURIComponent(link.slug)}&ref=${ref}`,
    ResolverSchema,
  ).catch((error: unknown) => {
    if (error instanceof TaigaError && /\(404\)/.test(error.message)) throw new TaigaError(`${link.prefix}-${ref} does not exist.`);
    throw error;
  });
  if (resolved.issue === undefined) {
    const kind = resolved.us !== undefined ? 'a user story' : resolved.task !== undefined ? 'a task' : resolved.epic !== undefined ? 'an epic' : 'not an issue';
    throw new TaigaError(`${link.prefix}-${ref} is ${kind}; taiga-link only handles issues.`);
  }
  const [detail, issue] = await Promise.all([
    projectDetail(client, link.id),
    client.get(`/issues/${resolved.issue}`, IssueDetailSchema),
  ]);
  return toView(link, detail, issue, issue.description ?? '');
}

export async function openIssues(client: TaigaClient, link: ProjectLink): Promise<IssueView[]> {
  const [detail, issues] = await Promise.all([
    projectDetail(client, link.id),
    client.get(`/issues?project=${link.id}&status__is_closed=false`, z.array(IssueSchema)),
  ]);
  return issues.map((i) => toView(link, detail, i, '')).filter((i) => !i.closed);
}

export async function comments(client: TaigaClient, issueId: number): Promise<CommentView[]> {
  const entries = await client.get(`/history/issue/${issueId}?type=comment`, z.array(CommentSchema));
  return entries
    .filter((e) => e.comment.trim() !== '' && (e.delete_comment_date ?? null) === null)
    .map((e) => ({ author: e.user?.name ?? e.user?.username ?? 'unknown', created: e.created_at, text: e.comment.trim() }))
    .sort((a, b) => a.created.localeCompare(b.created));
}

export async function attachments(client: TaigaClient, link: ProjectLink, issueId: number): Promise<Attachment[]> {
  const list = await client.get(`/issues/attachments?project=${link.id}&object_id=${issueId}`, z.array(AttachmentSchema));
  return list.filter((a) => a.is_deprecated !== true);
}

export function readyStatusId(detail: ProjectDetail, link: ProjectLink): number {
  const status = detail.issue_statuses.find((s) => s.name === link.readyStatus);
  if (status === undefined) {
    const names = detail.issue_statuses.map((s) => `"${s.name}"`).join(', ');
    throw new TaigaError(`Status "${link.readyStatus}" no longer exists in ${link.name} (have: ${names}). Fix it with "taiga link add ${link.slug} --prefix ${link.prefix} --ready-status <name>".`);
  }
  return status.id;
}

export async function updateIssue(
  client: TaigaClient,
  issue: IssueView,
  change: { comment: string; status?: number },
): Promise<void> {
  await client.patch(
    `/issues/${issue.id}`,
    { comment: change.comment, version: issue.version, ...(change.status === undefined ? {} : { status: change.status }) },
    z.object({ id: z.number().int() }),
  );
}
