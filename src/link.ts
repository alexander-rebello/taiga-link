import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TaigaClient, defaultUrl } from './api.js';
import {
  CONFIG_FILE,
  PREFIX_PATTERN,
  findConfigFile,
  normalizeUrl,
  projectRoot,
  readConfig,
  saveConfig,
  type LinkConfig,
  type ProjectLink,
} from './config.js';
import { TaigaError } from './errors.js';
import { projectBySlug, type ProjectDetail } from './taiga.js';

export interface LinkTarget {
  file: string;
  config: LinkConfig;
  exists: boolean;
}

/** The existing .taiga.json, or a new one at the repository root bound to the given or last used instance. */
export function linkTarget(cwd: string, urlOption: string | undefined): LinkTarget {
  const existing = findConfigFile(cwd);
  const wanted = urlOption === undefined ? undefined : normalizeUrl(urlOption);
  if (existing !== undefined) {
    const config = readConfig(existing);
    if (wanted !== undefined && wanted !== config.url) {
      throw new TaigaError(`${existing} is already linked to ${config.url}; one repository links one Taiga instance.`);
    }
    return { file: existing, config, exists: true };
  }
  const url = wanted ?? defaultUrl();
  if (url === undefined) throw new TaigaError('No Taiga instance known. Run "taiga login" first or pass --url.');
  return { file: join(projectRoot(cwd), CONFIG_FILE), config: { version: 1, url, projects: [] }, exists: false };
}

export function defaultPrefix(slug: string, taken: readonly string[]): string {
  const words = slug.toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w !== '' && /^[A-Z]/.test(w));
  const candidates = [
    words.length > 1 ? words.map((w) => w[0]).join('') : '',
    words.at(-1)?.slice(0, 4) ?? '',
    words[0]?.slice(0, 4) ?? '',
    'TG',
  ].filter((c) => PREFIX_PATTERN.test(c));
  const base = candidates.find((c) => !taken.includes(c)) ?? candidates[0] ?? 'TG';
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    const next = `${base.slice(0, 9)}${n}`;
    if (!taken.includes(next)) return next;
  }
}

export function upsertProject(config: LinkConfig, detail: ProjectDetail, prefixRaw: string, readyStatus: string): LinkConfig {
  const prefix = prefixRaw.trim().toUpperCase();
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new TaigaError(`Invalid prefix "${prefixRaw}": 2 to 10 characters, A-Z and 0-9, starting with a letter.`);
  }
  const clash = config.projects.find((p) => p.prefix === prefix && p.id !== detail.id);
  if (clash !== undefined) throw new TaigaError(`Prefix ${prefix} is already used by ${clash.name}.`);
  if (!detail.issue_statuses.some((s) => s.name === readyStatus)) {
    const names = detail.issue_statuses.map((s) => `"${s.name}"`).join(', ');
    throw new TaigaError(`${detail.name} has no issue status "${readyStatus}". Statuses: ${names}.`);
  }
  const link: ProjectLink = { id: detail.id, slug: detail.slug, name: detail.name, prefix, readyStatus };
  const others = config.projects.filter((p) => p.id !== detail.id);
  const index = config.projects.findIndex((p) => p.id === detail.id);
  const projects = index === -1 ? [...others, link] : config.projects.map((p) => (p.id === detail.id ? link : p));
  return { ...config, projects };
}

export async function addLink(cwd: string, slug: string, prefix: string, readyStatus: string, url: string | undefined): Promise<{ file: string; link: ProjectLink }> {
  const target = linkTarget(cwd, url);
  const client = await TaigaClient.open(target.config.url);
  const detail = await projectBySlug(client, slug).catch((error: unknown) => {
    if (error instanceof TaigaError && /\(404\)/.test(error.message)) throw new TaigaError(`No project "${slug}" on ${target.config.url}.`);
    throw error;
  });
  const next = upsertProject(target.config, detail, prefix, readyStatus);
  saveConfig(target.file, next);
  const link = next.projects.find((p) => p.id === detail.id);
  if (link === undefined) throw new TaigaError('internal: link missing after save');
  return { file: target.file, link };
}

export function removeLink(cwd: string, prefixRaw: string): { file: string; removed: ProjectLink } {
  const file = findConfigFile(cwd);
  if (file === undefined || !existsSync(file)) throw new TaigaError(`No ${CONFIG_FILE} here.`);
  const config = readConfig(file);
  const prefix = prefixRaw.trim().toUpperCase();
  const removed = config.projects.find((p) => p.prefix === prefix);
  if (removed === undefined) throw new TaigaError(`No linked project with prefix ${prefix}.`);
  saveConfig(file, { ...config, projects: config.projects.filter((p) => p.prefix !== prefix) });
  return { file, removed };
}
