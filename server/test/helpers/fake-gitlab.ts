import { Parser } from 'commonmark';
import type { FetchLike } from '../../src/adapters/gitlab/index.js';

/**
 * In-memory fake of the gitlab.com REST v4 + GraphQL surface DevDigest uses,
 * plugged into the REAL `RestGitLabClient` through `ContainerOverrides.gitlabFetch`
 * (spec 2026-10-20-gitlab-comments, plan T7). No network: every request is
 * answered here and recorded as `{ method, path, query, body, token }`.
 *
 * Default handlers model a tiny GitLab: tokens (→ user + scopes), projects,
 * merge requests (diff_refs) and their discussions. One-shot overrides
 * (`when(...)`) script failures — a status (with headers/body), a timeout or a
 * network error — for the next N matching requests.
 */

export interface FakeRequest {
  method: string;
  /** URL pathname, still percent-encoded (e.g. `/api/v4/projects/a%2Fb/...`). */
  path: string;
  query: Record<string, string>;
  /** Parsed JSON request body (POST), else undefined. */
  body: unknown;
  /** `PRIVATE-TOKEN` / `Authorization: Bearer` value, or null (anonymous). */
  token: string | null;
}

export type FakeReply =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | 'timeout'
  | 'network';

interface Rule {
  method: string;
  path: string | RegExp;
  reply: FakeReply;
  remaining: number;
}

export interface FakeNotePosition {
  position_type: string;
  base_sha?: string;
  start_sha?: string;
  head_sha: string;
  old_path?: string | null;
  new_path?: string | null;
  old_line?: number | null;
  new_line?: number | null;
}

export interface FakeNote {
  id: number;
  type: string | null;
  system: boolean;
  body: string;
  author: { username: string };
  created_at: string;
  position?: FakeNotePosition | null;
}

export interface FakeDiscussion {
  id: string;
  individual_note: boolean;
  notes: FakeNote[];
}

export interface FakeMr {
  iid: number;
  title: string;
  state: string;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  baseSha: string;
  startSha: string;
  headSha: string;
  discussions: FakeDiscussion[];
}

interface FakeProject {
  id: number;
  fullPath: string;
  defaultBranch: string;
  mrs: Map<number, FakeMr>;
}

export const FAKE_CREATED_AT = '2026-10-20T10:00:00.000Z';

const API = '/api/v4';

export class FakeGitLab {
  readonly requests: FakeRequest[] = [];
  private readonly tokens = new Map<string, { username: string; scopes: string[] | null }>();
  private readonly projects = new Map<string, FakeProject>();
  private rules: Rule[] = [];
  private nextNoteId = 9_000;
  private nextDiscussion = 1;
  private nextProjectId = 7_000;

  /** A token GitLab accepts, authenticating as `username` with `scopes` (null ⇒ no list). */
  addToken(token: string, username: string, scopes: string[] | null): this {
    this.tokens.set(token, { username, scopes });
    return this;
  }

  addProject(fullPath: string, defaultBranch = 'main'): this {
    this.projects.set(fullPath.toLowerCase(), {
      id: this.nextProjectId++,
      fullPath,
      defaultBranch,
      mrs: new Map(),
    });
    return this;
  }

  addMr(
    fullPath: string,
    iid: number,
    shas: { baseSha?: string; startSha?: string; headSha: string },
    meta: Partial<Pick<FakeMr, 'title' | 'state' | 'author'>> = {},
  ): FakeMr {
    let project = this.projects.get(fullPath.toLowerCase());
    if (!project) {
      this.addProject(fullPath);
      project = this.projects.get(fullPath.toLowerCase())!;
    }
    const mr: FakeMr = {
      iid,
      title: meta.title ?? `MR ${iid}`,
      state: meta.state ?? 'opened',
      sourceBranch: `feat/${iid}`,
      targetBranch: 'main',
      author: meta.author ?? 'olena.dev',
      baseSha: shas.baseSha ?? 'base000',
      startSha: shas.startSha ?? 'start000',
      headSha: shas.headSha,
      discussions: [],
    };
    project.mrs.set(iid, mr);
    return mr;
  }

  mr(fullPath: string, iid: number): FakeMr {
    const mr = this.projects.get(fullPath.toLowerCase())?.mrs.get(iid);
    if (!mr) throw new Error(`fake gitlab: no MR ${fullPath}!${iid}`);
    return mr;
  }

  /** Script the next `times` requests matching `method` + `path` (substring or RegExp). */
  when(method: string, path: string | RegExp, reply: FakeReply, times = 1): this {
    this.rules.push({ method, path, reply, remaining: times });
    return this;
  }

  /** Requests whose path matches (substring or RegExp), optionally by method. */
  matching(path: string | RegExp, method?: string): FakeRequest[] {
    return this.requests.filter(
      (r) => (!method || r.method === method) && matches(r.path, path),
    );
  }

  /** Every write (POST to the REST API; GraphQL reads excluded). */
  get writes(): FakeRequest[] {
    return this.requests.filter((r) => r.method === 'POST' && r.path.startsWith(API));
  }

  reset(): void {
    this.requests.length = 0;
    this.rules = [];
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    if (url.origin !== 'https://gitlab.com') throw new Error(`fake gitlab: unexpected origin ${url.origin}`);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const bearer = headers.get('authorization');
    const token =
      headers.get('private-token') ?? (bearer?.startsWith('Bearer ') ? bearer.slice(7) : null);
    let body: unknown;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const req: FakeRequest = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      body,
      token,
    };
    this.requests.push(req);

    const rule = this.rules.find((r) => r.remaining > 0 && r.method === method && matches(req.path, r.path));
    if (rule) {
      rule.remaining -= 1;
      if (rule.reply === 'timeout') {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      if (rule.reply === 'network') throw new TypeError('fetch failed');
      return json(rule.reply.status, rule.reply.body ?? { message: `${rule.reply.status}` }, rule.reply.headers);
    }
    return this.route(req);
  };

  // ---------- default handlers ----------

  private route(req: FakeRequest): Response {
    if (req.token !== null && !this.tokens.has(req.token)) {
      return json(401, { message: '401 Unauthorized' });
    }
    const user = req.token ? this.tokens.get(req.token)! : null;

    if (req.method === 'POST' && req.path === '/api/graphql') return this.graphql(req);
    if (!req.path.startsWith(`${API}/`)) return json(404, { message: '404 Not Found' });
    const rest = req.path.slice(API.length);

    if (req.method === 'GET' && rest === '/user') {
      return user ? json(200, { username: user.username }) : json(401, { message: '401 Unauthorized' });
    }
    if (req.method === 'GET' && rest === '/personal_access_tokens/self') {
      if (!user) return json(401, { message: '401 Unauthorized' });
      return json(200, user.scopes ? { scopes: user.scopes } : {});
    }

    const m = /^\/projects\/([^/]+)(\/.*)?$/.exec(rest);
    if (!m) return json(404, { message: '404 Not Found' });
    const project = this.projects.get(decodeURIComponent(m[1]!).toLowerCase());
    if (!project) return json(404, { message: '404 Project Not Found' });
    const sub = m[2] ?? '';

    if (req.method === 'GET' && sub === '') {
      return json(200, {
        id: project.id,
        path_with_namespace: project.fullPath,
        default_branch: project.defaultBranch,
        web_url: `https://gitlab.com/${project.fullPath}`,
      });
    }

    const mrMatch = /^\/merge_requests\/(\d+)(\/.*)?$/.exec(sub);
    if (!mrMatch) return json(404, { message: '404 Not Found' });
    const mr = project.mrs.get(Number(mrMatch[1]));
    if (!mr) return json(404, { message: '404 Merge Request Not Found' });
    const mrSub = mrMatch[2] ?? '';

    if (req.method === 'GET' && mrSub === '') return json(200, restMr(project, mr));
    if (req.method === 'GET' && (mrSub === '/diffs' || mrSub === '/commits' || mrSub === '/closes_issues')) {
      return json(200, [], { 'x-next-page': '' });
    }
    if (mrSub === '/discussions') {
      if (req.method === 'GET') return paginate(mr.discussions, req.query);
      if (req.method === 'POST') return this.createDiscussion(mr, req.body, user?.username ?? 'anonymous');
    }
    const dMatch = /^\/discussions\/([^/]+)(\/notes)?$/.exec(mrSub);
    if (dMatch) {
      const id = decodeURIComponent(dMatch[1]!);
      const discussion = mr.discussions.find((d) => d.id === id);
      if (!discussion) return json(404, { message: '404 Discussion Not Found' });
      if (req.method === 'GET' && !dMatch[2]) return json(200, discussion);
      if (req.method === 'POST' && dMatch[2]) {
        const note: FakeNote = {
          id: this.nextNoteId++,
          type: 'DiffNote',
          system: false,
          body: String((req.body as { body?: unknown } | undefined)?.body ?? ''),
          author: { username: user?.username ?? 'anonymous' },
          created_at: FAKE_CREATED_AT,
          position: discussion.notes[0]?.position ?? null,
        };
        discussion.notes.push(note);
        return json(201, note);
      }
    }
    return json(404, { message: '404 Not Found' });
  }

  private createDiscussion(mr: FakeMr, raw: unknown, author: string): Response {
    const input = (raw ?? {}) as { body?: unknown; position?: FakeNotePosition };
    const note: FakeNote = {
      id: this.nextNoteId++,
      type: 'DiffNote',
      system: false,
      body: String(input.body ?? ''),
      author: { username: author },
      created_at: FAKE_CREATED_AT,
      position: input.position
        ? {
            old_line: null,
            new_line: null,
            ...input.position,
          }
        : null,
    };
    const discussion: FakeDiscussion = {
      id: `disc-${this.nextDiscussion++}`,
      individual_note: false,
      notes: [note],
    };
    mr.discussions.push(discussion);
    return json(201, discussion);
  }

  private graphql(req: FakeRequest): Response {
    const { query, variables } = (req.body ?? {}) as {
      query?: string;
      variables?: { fullPath?: string; iids?: string[] };
    };
    const project = this.projects.get(String(variables?.fullPath ?? '').toLowerCase());
    if (!project) return json(200, { data: { project: null } });
    const mrs = [...project.mrs.values()];
    if (query?.includes('DevDigestOpenMergeRequests')) {
      return json(200, {
        data: {
          project: {
            mergeRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: mrs
                .filter((mr) => mr.state === 'opened')
                .map((mr) => ({
                  iid: String(mr.iid),
                  title: mr.title,
                  draft: false,
                  state: mr.state,
                  sourceBranch: mr.sourceBranch,
                  targetBranch: mr.targetBranch,
                  diffHeadSha: mr.headSha,
                  createdAt: FAKE_CREATED_AT,
                  updatedAt: FAKE_CREATED_AT,
                  author: { username: mr.author },
                  diffStatsSummary: { additions: 1, deletions: 0, fileCount: 1 },
                })),
            },
          },
        },
      });
    }
    if (query?.includes('DevDigestMergeRequestStates')) {
      const wanted = new Set(variables?.iids ?? []);
      return json(200, {
        data: {
          project: {
            mergeRequests: {
              nodes: mrs.filter((mr) => wanted.has(String(mr.iid))).map((mr) => ({ iid: String(mr.iid), state: mr.state })),
            },
          },
        },
      });
    }
    return json(200, { data: { project: { mergeRequest: { diffStatsSummary: null } } } });
  }
}

// ---------- builders for seeded discussions ----------

/** A `text` DiffNote position anchored at `headSha`. */
export function textPosition(
  headSha: string,
  p: { oldPath?: string; newPath?: string; oldLine?: number | null; newLine?: number | null },
): FakeNotePosition {
  return {
    position_type: 'text',
    base_sha: 'base000',
    start_sha: 'start000',
    head_sha: headSha,
    old_path: p.oldPath ?? p.newPath ?? null,
    new_path: p.newPath ?? p.oldPath ?? null,
    old_line: p.oldLine ?? null,
    new_line: p.newLine ?? null,
  };
}

export function diffNote(
  id: number,
  author: string,
  body: string,
  position: FakeNotePosition | null,
  extra: Partial<FakeNote> = {},
): FakeNote {
  return {
    id,
    type: 'DiffNote',
    system: false,
    body,
    author: { username: author },
    created_at: FAKE_CREATED_AT,
    position,
    ...extra,
  };
}

// ---------- quick-action oracle (plan "Quick-action neutralisation") ----------

const QUICK_ACTIONS = [
  'merge', 'close', 'reopen', 'approve', 'unapprove', 'assign', 'unassign', 'label', 'unlabel',
  'relabel', 'milestone', 'draft', 'ready', 'rebase', 'submit_review', 'shrug', 'tableflip',
  'spend', 'estimate',
];

/** GitLab's command regex (`commands_regex`, flags m + i), command alternative only. */
const COMMAND_RE = new RegExp(
  `^\\/(?<cmd>${QUICK_ACTIONS.join('|')})(?:[ ](?<arg>[^\\n]*))?(?:\\s*\\n|$)`,
  'gmi',
);

/**
 * Model of GitLab's quick-action extractor (`lib/gitlab/quick_actions/extractor.rb`
 * + `lib/banzai/filter/quick_action_filter.rb`, master 2026-10-20) — the commands
 * GitLab would run for `text`:
 *
 * 1. `content.delete!("\r")`;
 * 2. Markdown parse (CommonMark via `commonmark`, standing in for Banzai's
 *    MarkdownFilter) → TOP-LEVEL paragraphs only, with their source lines;
 * 3. per paragraph: raw lines `start..end`, plus the next line when it is blank;
 * 4. the command regex over that slice.
 *
 * Deliberately CONSERVATIVE (it may report more than GitLab, never less): it
 * skips the filter's "paragraph text starts with `/`" check and the extractor's
 * EXCLUSION_REGEX (inline code / HTML block spans), both of which only remove
 * matches.
 */
export function quickActionMatches(text: string): string[] {
  const content = text.replace(/\r/g, '');
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const doc = new Parser().parse(content);
  const found: string[] = [];
  for (let node = doc.firstChild; node; node = node.next) {
    if (node.type !== 'paragraph') continue;
    const start = node.sourcepos[0][0] - 1;
    let end = node.sourcepos[1][0] - 1;
    if (lines[end + 1] === '\n') end += 1;
    const paragraph = lines.slice(start, end + 1).join('');
    for (const m of paragraph.matchAll(COMMAND_RE)) found.push(m.groups!.cmd!);
  }
  return found;
}

// ---------- internals ----------

function matches(path: string, pattern: string | RegExp): boolean {
  return typeof pattern === 'string' ? path.includes(pattern) : pattern.test(path);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function restMr(project: FakeProject, mr: FakeMr) {
  return {
    iid: mr.iid,
    project_id: project.id,
    title: mr.title,
    description: null,
    state: mr.state,
    draft: false,
    source_branch: mr.sourceBranch,
    target_branch: mr.targetBranch,
    sha: mr.headSha,
    diff_refs: { base_sha: mr.baseSha, start_sha: mr.startSha, head_sha: mr.headSha },
    author: { username: mr.author },
    created_at: FAKE_CREATED_AT,
    updated_at: FAKE_CREATED_AT,
  };
}

function paginate<T>(items: readonly T[], query: Record<string, string>): Response {
  const perPage = Math.max(1, Number(query.per_page ?? 20));
  const page = Math.max(1, Number(query.page ?? 1));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const hasNext = page * perPage < items.length;
  return json(200, slice, { 'x-next-page': hasNext ? String(page + 1) : '' });
}
