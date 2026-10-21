import { Parser } from 'commonmark';
import type { FetchLike } from '../../src/adapters/gitlab/index.js';

/**
 * In-memory fake of the gitlab.com REST v4 + GraphQL surface DevDigest uses,
 * plugged into the REAL `RestGitLabClient` through `ContainerOverrides.gitlabFetch`
 * (spec 2026-10-20-gitlab-comments, plan T7). No network: every request is
 * answered here and recorded as `{ method, path, query, body, token }`.
 *
 * Default handlers model a tiny GitLab: tokens (→ user + scopes), projects,
 * merge requests (diff_refs), their discussions and — for publish (spec
 * 2026-10-21-gitlab-publish-findings, plan T11) — per-author draft notes with
 * `bulk_publish`. One-shot overrides (`when(...)`) script failures — a status
 * (with headers/body), a timeout or a network error — for the next N matching
 * requests; `applyFirst` lets the write land before the failure is answered,
 * `delayMs` / `latencyMs` / `gate` slow requests down.
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
  | {
      status: number;
      body?: unknown;
      headers?: Record<string, string>;
      /** Run the default handler first (the write LANDS), then answer `status`. */
      applyFirst?: boolean;
      /** Extra latency before answering. */
      delayMs?: number;
    }
  /** The default handler, after `delayMs` and/or once `gate` settles. */
  | { passThrough: true; delayMs?: number; gate?: Promise<unknown> }
  | 'timeout'
  | 'network';

export interface WhenOptions {
  /** Let the first `skip` matching requests through to the default handler. */
  skip?: number;
  /** Only requests satisfying this predicate match the rule. */
  match?: (req: FakeRequest) => boolean;
}

interface Rule {
  method: string;
  path: string | RegExp;
  reply: FakeReply;
  remaining: number;
  skip: number;
  match?: (req: FakeRequest) => boolean;
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

/** One draft note of `author` on an MR (only that user can list / delete / publish it). */
export interface FakeDraft {
  id: number;
  author: string;
  note: string;
  /** The request `position` as sent (incl. `line_range`), or null for a general note. */
  position: Record<string, unknown> | null;
}

/** The publish marker shape (`modules/_shared/publish-marker.ts`), ids captured. */
const MARKER_LINE_RE =
  /^<!-- devdigest:publish:v1 w=([0-9a-f-]{36}) p=([0-9a-f-]{36}) f=([0-9a-f-]{36}) -->$/m;

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
  drafts: FakeDraft[];
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
  private nextDraftId = 50_000;
  private readonly hiddenNotes = new Set<number>();
  private readonly hiddenNotePredicates: ((note: FakeNote) => boolean)[] = [];
  /** Global latency (ms) added before answering EVERY request. */
  latencyMs = 0;

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
      drafts: [],
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
  when(method: string, path: string | RegExp, reply: FakeReply, times = 1, opts: WhenOptions = {}): this {
    this.rules.push({ method, path, reply, remaining: times, skip: opts.skip ?? 0, match: opts.match });
    return this;
  }

  // ---------- draft notes (publish) ----------

  /** Every draft on the MR (all authors), in creation order. */
  drafts(fullPath: string, iid: number): FakeDraft[] {
    return this.mr(fullPath, iid).drafts;
  }

  /** A draft written by someone (a human reviewer using the service account, another tool). */
  addHumanDraft(fullPath: string, iid: number, author: string, note: string, position: Record<string, unknown> | null = null): FakeDraft {
    const draft: FakeDraft = { id: this.nextDraftId++, author, note, position };
    this.mr(fullPath, iid).drafts.push(draft);
    return draft;
  }

  /** Every non-system note of every discussion of the MR (hidden ones included). */
  notes(fullPath: string, iid: number): FakeNote[] {
    return this.mr(fullPath, iid).discussions.flatMap((d) => d.notes);
  }

  /**
   * Count of publish markers on the MR: `drafts` (default), published `notes`,
   * or `all`; optionally only those of one publication / finding.
   */
  markerCount(
    fullPath: string,
    iid: number,
    where: 'drafts' | 'notes' | 'all' = 'drafts',
    filter: { publicationId?: string; findingId?: string } = {},
  ): number {
    const bodies: string[] = [];
    if (where !== 'notes') bodies.push(...this.drafts(fullPath, iid).map((d) => d.note));
    if (where !== 'drafts') bodies.push(...this.notes(fullPath, iid).map((n) => n.body));
    return bodies.filter((b) => {
      const m = MARKER_LINE_RE.exec(b);
      if (!m) return false;
      if (filter.publicationId && m[2] !== filter.publicationId) return false;
      if (filter.findingId && m[3] !== filter.findingId) return false;
      return true;
    }).length;
  }

  /** Hide a published note from every discussion read (AC-27: "note not found by marker"). */
  hideNote(noteIdOrPredicate: number | ((note: FakeNote) => boolean)): this {
    if (typeof noteIdOrPredicate === 'number') this.hiddenNotes.add(noteIdOrPredicate);
    else this.hiddenNotePredicates.push(noteIdOrPredicate);
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

  /** Every DELETE to the REST API. */
  get deletes(): FakeRequest[] {
    return this.requests.filter((r) => r.method === 'DELETE' && r.path.startsWith(API));
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
    if (this.latencyMs > 0) await sleep(this.latencyMs);

    const rule = this.rules.find(
      (r) => r.remaining > 0 && r.method === method && matches(req.path, r.path) && (!r.match || r.match(req)),
    );
    if (rule && rule.skip > 0) {
      rule.skip -= 1;
      return this.route(req);
    }
    if (rule) {
      rule.remaining -= 1;
      const reply = rule.reply;
      if (reply === 'timeout') {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      if (reply === 'network') throw new TypeError('fetch failed');
      if (reply.delayMs) await sleep(reply.delayMs);
      if ('passThrough' in reply) {
        if (reply.gate) await reply.gate;
        return this.route(req);
      }
      if (reply.applyFirst) this.route(req);
      return json(reply.status, reply.body ?? { message: `${reply.status}` }, reply.headers);
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
      if (req.method === 'GET') return paginate(this.visibleDiscussions(mr), req.query);
      if (req.method === 'POST') return this.createDiscussion(mr, req.body, user?.username ?? 'anonymous');
    }
    if (mrSub === '/draft_notes' || mrSub.startsWith('/draft_notes/')) {
      return this.draftNotes(mr, req, mrSub.slice('/draft_notes'.length), user?.username ?? 'anonymous');
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

  /** Discussions as a read returns them: hidden notes removed, emptied discussions dropped. */
  private visibleDiscussions(mr: FakeMr): FakeDiscussion[] {
    if (this.hiddenNotes.size === 0 && this.hiddenNotePredicates.length === 0) return mr.discussions;
    const hidden = (n: FakeNote) => this.hiddenNotes.has(n.id) || this.hiddenNotePredicates.some((p) => p(n));
    return mr.discussions
      .map((d) => ({ ...d, notes: d.notes.filter((n) => !hidden(n)) }))
      .filter((d) => d.notes.length > 0);
  }

  /**
   * `…/merge_requests/:iid/draft_notes[/:id | /bulk_publish]`. Drafts are
   * per author: list / delete / publish only ever see the token user's own.
   */
  private draftNotes(mr: FakeMr, req: FakeRequest, rest: string, author: string): Response {
    const own = () => mr.drafts.filter((d) => d.author === author);
    if (rest === '') {
      if (req.method === 'GET') {
        return paginate(own().map((d) => ({ id: d.id, note: d.note, position: d.position })), req.query);
      }
      if (req.method === 'POST') {
        const input = (req.body ?? {}) as { note?: unknown; position?: unknown };
        const position = input.position ?? null;
        if (position !== null && !validDraftPosition(position)) {
          return json(400, { message: '400 Bad request - position is invalid' });
        }
        const draft: FakeDraft = {
          id: this.nextDraftId++,
          author,
          note: String(input.note ?? ''),
          position: position as Record<string, unknown> | null,
        };
        mr.drafts.push(draft);
        return json(201, { id: draft.id, note: draft.note, position: draft.position });
      }
    }
    if (rest === '/bulk_publish' && req.method === 'POST') {
      const summary = (req.body as { note?: unknown } | undefined)?.note;
      for (const draft of own()) this.publishDraft(mr, draft);
      mr.drafts = mr.drafts.filter((d) => d.author !== author);
      if (typeof summary === 'string') {
        mr.discussions.push({
          id: `disc-${this.nextDiscussion++}`,
          individual_note: true,
          notes: [diffNote(this.nextNoteId++, author, summary, null, { type: null })],
        });
      }
      return new Response(null, { status: 204 });
    }
    const idMatch = /^\/(\d+)$/.exec(rest);
    if (idMatch && req.method === 'DELETE') {
      const id = Number(idMatch[1]);
      const index = mr.drafts.findIndex((d) => d.id === id && d.author === author);
      if (index < 0) return json(404, { message: '404 Draft Note Not Found' });
      mr.drafts.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    return json(404, { message: '404 Not Found' });
  }

  /** A published draft: positioned → a `DiffNote` discussion; unpositioned → an individual general note. */
  private publishDraft(mr: FakeMr, draft: FakeDraft): void {
    const id = `disc-${this.nextDiscussion++}`;
    if (draft.position) {
      const { line_range: _range, ...position } = draft.position as Record<string, unknown> & { line_range?: unknown };
      mr.discussions.push({
        id,
        individual_note: false,
        notes: [
          diffNote(this.nextNoteId++, draft.author, draft.note, {
            old_line: null,
            new_line: null,
            ...(position as unknown as FakeNotePosition),
          }),
        ],
      });
      return;
    }
    mr.discussions.push({
      id,
      individual_note: true,
      notes: [diffNote(this.nextNoteId++, draft.author, draft.note, null, { type: null })],
    });
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

/**
 * AC-13 security property, parser-independent: the raw lines (split on `\n`
 * only — Ruby's `^`/`$`) that GitLab's command regex could match for ANY command
 * name — `^\/<name>(?:[ ]<arg>)?\s*$` — with a generic ASCII name and, wider, a
 * Unicode one (Ruby's `/i` case-folds U+212A → `k`, U+017F → `s`, …). Ignores
 * Markdown structure entirely: after neutralisation this must be empty for EVERY
 * input, whatever GitLab decides is code or paragraph.
 */
export function rawCommandLines(text: string): string[] {
  return text
    .split('\n')
    .filter(
      (line) =>
        /^\/[A-Za-z_][A-Za-z0-9_]*(?:[ ][^\n]*)?\s*$/.test(line) ||
        /^\/[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*(?:\s|$)/u.test(line),
    );
}

// ---------- internals ----------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** GitLab rejects a draft position without a text anchor, or a `line_range` missing an end (400). */
function validDraftPosition(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const p = raw as Record<string, unknown>;
  if (p.position_type !== 'text' || typeof p.head_sha !== 'string') return false;
  if (typeof p.new_path !== 'string' && typeof p.old_path !== 'string') return false;
  if (p.new_line == null && p.old_line == null) return false;
  if (p.line_range !== undefined) {
    const range = p.line_range as { start?: unknown; end?: unknown } | null;
    if (!range || typeof range !== 'object' || !range.start || !range.end) return false;
  }
  return true;
}

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
