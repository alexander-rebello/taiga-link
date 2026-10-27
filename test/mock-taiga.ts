import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
}

export interface MockIssue {
  id: number;
  ref: number;
  project: number;
  subject: string;
  description: string;
  status: number;
  type: number;
  priority: number;
  severity: number;
  assigned_to: number | null;
  created_date: string;
  version: number;
}

export interface MockTaiga {
  url: string;
  requests: RecordedRequest[];
  issues: MockIssue[];
  /** Makes the current access token invalid so the next call has to refresh. */
  expireToken: () => void;
  /** Makes refresh fail too. */
  revokeRefresh: () => void;
  mediaBytes: Map<string, Buffer>;
  close: () => Promise<void>;
}

export const USER = { id: 7, username: 'dev', password: 'secret' };

const PROJECTS = [
  { id: 1, name: 'Acme ERP', slug: 'acme-erp' },
  { id: 2, name: 'Website', slug: 'website' },
  { id: 3, name: 'Archive', slug: 'archive' },
];

const STATUSES = [
  { id: 10, name: 'New', is_closed: false },
  { id: 11, name: 'In progress', is_closed: false },
  { id: 12, name: 'Ready for test', is_closed: false },
  { id: 13, name: 'Closed', is_closed: true },
];

function detail(id: number): Record<string, unknown> | undefined {
  const p = PROJECTS.find((x) => x.id === id);
  if (p === undefined) return undefined;
  return {
    ...p,
    issue_statuses: STATUSES.map((s) => ({ ...s, id: s.id + (id - 1) * 100 })),
    issue_types: [
      { id: 20, name: 'Bug' },
      { id: 21, name: 'Enhancement' },
    ],
    priorities: [
      { id: 30, name: 'Normal' },
      { id: 31, name: 'High' },
    ],
    severities: [
      { id: 40, name: 'Normal' },
      { id: 41, name: 'Critical' },
      { id: 42, name: 'Wishlist' },
    ],
  };
}

function initialIssues(): MockIssue[] {
  const base = { type: 20, priority: 30, severity: 40, assigned_to: null, version: 1, description: '' };
  return [
    { ...base, id: 100, ref: 12, project: 1, subject: 'Login fails on Safari', description: 'Steps: open /login in Safari 18.', status: 10, priority: 31, severity: 41, created_date: '2026-10-20T09:00:00Z', version: 3 },
    { ...base, id: 101, ref: 14, project: 1, subject: 'Add CSV export', type: 21, status: 11, assigned_to: 7, created_date: '2026-09-01T09:00:00Z' },
    { ...base, id: 102, ref: 15, project: 1, subject: 'Old closed thing', status: 13, created_date: '2026-08-01T09:00:00Z' },
    { ...base, id: 103, ref: 16, project: 1, subject: 'Login broken in Safari', status: 10, created_date: '2026-10-25T09:00:00Z' },
    { ...base, id: 200, ref: 3, project: 2, subject: 'Footer typo', status: 110, severity: 42, created_date: '2026-10-22T09:00:00Z' },
  ];
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function startMockTaiga(): Promise<MockTaiga> {
  const requests: RecordedRequest[] = [];
  const issues = initialIssues();
  const mediaBytes = new Map<string, Buffer>([
    ['shot.png', Buffer.from('PNGDATA')],
    ['clip.mp4', Buffer.from('VIDEO')],
    ['evil.txt', Buffer.from('EVIL')],
  ]);
  let tokenGen = 1;
  let refreshValid = true;
  let validToken = 'access-1';
  let validRefresh = 'refresh-1';

  let url = '';

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const parsed = new URL(req.url ?? '/', 'http://localhost');
    const path = parsed.pathname.replace(/^\/api\/v1/, '');
    const body = await readBody(req);
    requests.push({ method: req.method ?? 'GET', path: `${path}${parsed.search}`, auth: req.headers.authorization, body });
    const send = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const q = parsed.searchParams;

    if (req.method === 'POST' && path === '/auth') {
      const b = body as { username?: string; password?: string; type?: string };
      if (b.type !== 'normal' || b.username !== USER.username || b.password !== USER.password) {
        send(400, { _error_message: 'Username or password does not match user.' });
        return;
      }
      send(200, { id: USER.id, username: USER.username, auth_token: validToken, refresh: validRefresh });
      return;
    }
    if (req.method === 'POST' && path === '/auth/refresh') {
      const b = body as { refresh?: string };
      if (!refreshValid || b.refresh !== validRefresh) {
        send(401, { detail: 'Token is invalid or expired' });
        return;
      }
      tokenGen += 1;
      validToken = `access-${tokenGen}`;
      validRefresh = `refresh-${tokenGen}`;
      send(200, { auth_token: validToken, refresh: validRefresh });
      return;
    }

    if (req.headers.authorization !== `Bearer ${validToken}`) {
      send(401, { detail: 'Invalid token' });
      return;
    }

    if (path.startsWith('/media/')) {
      const name = path.slice('/media/'.length);
      const bytes = mediaBytes.get(name);
      if (bytes === undefined) {
        send(404, { detail: 'not found' });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(bytes);
      return;
    }
    if (path === '/users/me') {
      send(200, { id: USER.id, username: USER.username });
      return;
    }
    if (path === '/projects' && q.get('member') === String(USER.id)) {
      send(200, PROJECTS);
      return;
    }
    if (path === '/projects/by_slug') {
      const p = PROJECTS.find((x) => x.slug === q.get('slug'));
      if (p === undefined) send(404, { detail: 'No Project matches the given query.' });
      else send(200, p);
      return;
    }
    const projectMatch = /^\/projects\/(\d+)$/.exec(path);
    if (projectMatch !== null) {
      const d = detail(Number(projectMatch[1]));
      if (d === undefined) send(404, {});
      else send(200, d);
      return;
    }
    if (path === '/resolver') {
      const p = PROJECTS.find((x) => x.slug === q.get('project'));
      const ref = Number(q.get('ref'));
      if (p === undefined) {
        send(404, {});
        return;
      }
      if (p.id === 1 && ref === 13) {
        send(200, { project: 1, us: 500 });
        return;
      }
      const issue = issues.find((i) => i.project === p.id && i.ref === ref);
      if (issue === undefined) send(404, { detail: 'Not found.' });
      else send(200, { project: p.id, issue: issue.id });
      return;
    }
    if (path === '/issues' && req.method === 'GET') {
      const project = Number(q.get('project'));
      const d = detail(project);
      const closedIds = new Set(
        ((d?.issue_statuses ?? []) as { id: number; is_closed: boolean }[]).filter((s) => s.is_closed).map((s) => s.id),
      );
      const list = issues
        .filter((i) => i.project === project)
        .filter((i) => q.get('status__is_closed') !== 'false' || !closedIds.has(i.status))
        .map((issue) => ({
          ...Object.fromEntries(Object.entries(issue).filter(([k]) => k !== 'description')),
          modified_date: issue.created_date,
          assigned_to_extra_info: issue.assigned_to === null ? null : { full_name_display: 'Dev User' },
        }));
      send(200, list);
      return;
    }
    if (path === '/issues/attachments') {
      if (q.get('object_id') === '100' && q.get('project') === '1') {
        send(200, [
          { id: 1, name: 'shot.png', size: 7, url: `${url}/media/shot.png`, is_deprecated: false },
          { id: 2, name: 'clip.mp4', size: 5, url: `${url}/media/clip.mp4`, is_deprecated: false },
          { id: 3, name: '../../evil.txt', size: 4, url: `${url}/media/evil.txt`, is_deprecated: false },
          { id: 4, name: 'huge.zip', size: 30 * 1024 * 1024, url: `${url}/media/huge.zip`, is_deprecated: false },
          { id: 5, name: 'old.png', size: 1, url: `${url}/media/old.png`, is_deprecated: true },
        ]);
      } else send(200, []);
      return;
    }
    const historyMatch = /^\/history\/issue\/(\d+)$/.exec(path);
    if (historyMatch !== null) {
      if (historyMatch[1] === '100') {
        send(200, [
          { comment: 'Second comment', user: { name: 'Tester' }, created_at: '2026-10-21T10:00:00Z', delete_comment_date: null },
          { comment: 'Happens on Safari only', user: { name: 'Tester' }, created_at: '2026-10-20T10:00:00Z', delete_comment_date: null },
          { comment: 'deleted words', user: { name: 'Tester' }, created_at: '2026-10-20T11:00:00Z', delete_comment_date: '2026-10-20T12:00:00Z' },
          { comment: '', user: { name: 'Bot' }, created_at: '2026-10-20T13:00:00Z', delete_comment_date: null },
        ]);
      } else send(200, []);
      return;
    }
    const issueMatch = /^\/issues\/(\d+)$/.exec(path);
    if (issueMatch !== null) {
      const issue = issues.find((i) => i.id === Number(issueMatch[1]));
      if (issue === undefined) {
        send(404, {});
        return;
      }
      if (req.method === 'PATCH') {
        const b = body as { version?: number; status?: number };
        if (b.version !== issue.version) {
          send(400, { _error_message: 'The version doesn\'t match with the current one' });
          return;
        }
        issue.version += 1;
        if (b.status !== undefined) issue.status = b.status;
      }
      send(200, {
        ...issue,
        modified_date: issue.created_date,
        assigned_to_extra_info: issue.assigned_to === null ? null : { full_name_display: 'Dev User' },
      });
      return;
    }
    send(404, { detail: `mock: no route for ${req.method ?? ''} ${path}` });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    requests,
    issues,
    mediaBytes,
    expireToken: (): void => {
      validToken = `expired-${tokenGen}`;
    },
    revokeRefresh: (): void => {
      refreshValid = false;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
