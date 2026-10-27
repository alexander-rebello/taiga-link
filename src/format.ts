import type { Attachment, CommentView, IssueView } from './taiga.js';

export function issueUrl(base: string, slug: string, ref: number): string {
  return `${base}/project/${slug}/issue/${ref}`;
}

export function formatSize(bytes: number | null): string {
  if (bytes === null) return '? B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function issueLine(issue: IssueView): string {
  const who = issue.assignedTo === null ? 'unassigned' : issue.assignedTo;
  return `${issue.key.padEnd(9)} [${issue.status}] ${issue.type}, ${issue.priority}  ${issue.subject}  (${who})`;
}

export interface IssueDocument {
  issue: IssueView;
  url: string;
  comments: CommentView[];
  attachments: Attachment[];
  workgateId?: number | undefined;
}

export function formatIssue(doc: IssueDocument): string {
  const { issue } = doc;
  const lines = [
    `${issue.key} ${issue.subject}`,
    `Status: ${issue.status} | Type: ${issue.type} | Priority: ${issue.priority} | Severity: ${issue.severity} | Assigned: ${issue.assignedTo ?? 'unassigned'}`,
    `URL: ${doc.url}`,
  ];
  if (doc.workgateId !== undefined) lines.push(`Workgate: #${doc.workgateId}`);
  lines.push('', 'Description:', issue.description.trim() === '' ? '(none)' : issue.description.trim());
  if (doc.comments.length > 0) {
    lines.push('', `Comments (${doc.comments.length}):`);
    for (const c of doc.comments) lines.push(`- ${c.author}, ${c.created.slice(0, 10)}: ${c.text.replace(/\n/g, '\n  ')}`);
  }
  if (doc.attachments.length > 0) {
    lines.push('', `Attachments (${doc.attachments.length}), download with "taiga fetch ${issue.key}":`);
    for (const a of doc.attachments) lines.push(`- ${a.name} (${formatSize(a.size)})`);
  }
  return lines.join('\n');
}
