import type { LinkConfig, ProjectLink } from './config.js';
import { TaigaError } from './errors.js';

export interface IssueRef {
  project: ProjectLink;
  ref: number;
  key: string;
}

const REF_PATTERN = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,9})\b/g;

/** Only prefixes linked in .taiga.json count, so "UTF-8" or "ISO-9001" never match. */
export function findRefs(text: string, config: LinkConfig, limit = 5): IssueRef[] {
  const found = new Map<string, IssueRef>();
  for (const match of text.matchAll(REF_PATTERN)) {
    const project = config.projects.find((p) => p.prefix === match[1]);
    if (project === undefined) continue;
    const ref = Number(match[2]);
    const key = `${project.prefix}-${ref}`;
    if (!found.has(key)) found.set(key, { project, ref, key });
    if (found.size >= limit) break;
  }
  return [...found.values()];
}

export function resolveRef(config: LinkConfig, text: string): IssueRef {
  const match = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})$/.exec(text.trim());
  if (match === null) {
    throw new TaigaError(`"${text}" is not a Taiga reference. Use <PREFIX>-<number>, for example ${config.projects[0]?.prefix ?? 'ERP'}-123. Bare numbers are workgate ids.`);
  }
  const prefix = (match[1] ?? '').toUpperCase();
  const project = config.projects.find((p) => p.prefix === prefix);
  if (project === undefined) {
    const known = config.projects.map((p) => p.prefix).join(', ') || 'none';
    throw new TaigaError(`Unknown prefix "${prefix}". Linked prefixes: ${known}.`);
  }
  const ref = Number(match[2]);
  return { project, ref, key: `${project.prefix}-${ref}` };
}
