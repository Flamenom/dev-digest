import type { z } from 'zod';
import type {
  LLMProvider,
  ModelInfo,
  CompletionRequest,
  CompletionResult,
  StructuredRequest,
  StructuredResult,
  Embedder,
  GitHubClient,
  RepoRef,
  PrMeta,
  PrDetail,
  GitHubReviewPayload,
  CreateReviewCommentInput,
  PrReviewComment,
  OpenPrPayload,
  CommitFilesPayload,
  IssueMeta,
  HostGitClient,
  FetchPullHeadOptions,
  CloneOptions,
  UnifiedDiff,
  BlameLine,
  GitCommit,
  CodeIndex,
  CodeMatch,
  CodeSymbol,
  CodeReference,
  AuthProvider,
  AuthUser,
  AuthWorkspace,
  SecretsProvider,
  SecretKey,
  GitLabClient,
  GitLabProjectInfo,
  GitLabTokenCheck,
  HostRepoRef,
  IssueMetaHost,
  PrDetailHost,
  PrMetaHost,
  PrStatus,
  PullDetailOptions,
  PullDetailResult,
  PullStateInfo,
  IdentityProvider,
  AuthorizationUrlInput,
  CodeExchangeInput,
  CodeExchangeResult,
  VerifyIdTokenInput,
  VerifiedIdentity,
} from '@devdigest/shared';
import { parseUnifiedDiff } from './git/diff-parser.js';
import { AuthFlowError } from '../platform/auth-errors.js';

/**
 * Deterministic MOCK adapters for tests/dev — NO real network. Each mirrors the
 * adapter interface. The mock LLM returns a caller-supplied fixture (or a default)
 * for completeStructured, so review/grounding flows can be tested end-to-end.
 */

// ---------- Mock LLM ----------
export interface MockLLMOptions {
  models?: ModelInfo[];
  /** Fixture returned by completeStructured (validated against the schema). */
  structured?: unknown;
  /**
   * Per-schemaName fixtures for multi-call flows (e.g. the conventions 2-step
   * dialogue: 'ConventionFileSelection' then 'ConventionExtraction'). Looked up
   * by req.schemaName; falls back to `structured` when no entry matches.
   */
  structuredBySchema?: Record<string, unknown>;
  completionText?: string;
  embedding?: number[];
}

export class MockLLMProvider implements LLMProvider {
  // The port's FULL union (plan C2): every seeded agent is `provider:
  // 'openrouter'`, and `ContainerOverrides.llm` already keys that id, so a
  // narrower type here made the seeded agents unmockable without an API key.
  readonly id: LLMProvider['id'];
  public calls: { method: string; req: unknown }[] = [];

  constructor(
    id: LLMProvider['id'] = 'openai',
    private opts: MockLLMOptions = {},
  ) {
    this.id = id;
  }

  async listModels(): Promise<ModelInfo[]> {
    this.calls.push({ method: 'listModels', req: null });
    return (
      this.opts.models ?? [
        { id: 'gpt-4.1', provider: this.id === 'anthropic' ? 'anthropic' : 'openai' },
      ]
    );
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push({ method: 'complete', req });
    return {
      text: this.opts.completionText ?? 'mock completion',
      model: req.model,
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.001,
    };
  }

  async completeStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push({ method: 'completeStructured', req });
    const fixture = this.opts.structuredBySchema?.[req.schemaName] ?? this.opts.structured ?? {};
    const parsed = (req.schema as z.ZodType<T>).safeParse(fixture);
    if (!parsed.success) {
      throw new Error(`MockLLMProvider fixture failed schema: ${parsed.error.message}`);
    }
    return {
      data: parsed.data,
      model: req.model,
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.001,
      raw: JSON.stringify(fixture),
      attempts: 1,
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push({ method: 'embed', req: texts });
    return texts.map(() => this.opts.embedding ?? new Array(1536).fill(0));
  }
}

// ---------- Mock Embedder ----------
export class MockEmbedder implements Embedder {
  readonly dims = 1536;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((_, i) => new Array(1536).fill(0).map((_, j) => (i + j) % 2));
  }
}

// ---------- Mock GitHub ----------
export interface MockGitHubOptions {
  pulls?: PrMeta[];
  detail?: Partial<PrDetail>;
  login?: string;
  /** Existing inline review comments returned by listReviewComments. */
  comments?: PrReviewComment[];
}

export class MockGitHubClient implements GitHubClient {
  public posted: { n: number; review: GitHubReviewPayload }[] = [];
  public openedPrs: OpenPrPayload[] = [];
  public committed: CommitFilesPayload[] = [];
  public createdComments: CreateReviewCommentInput[] = [];

  constructor(private opts: MockGitHubOptions = {}) {}

  async listPullRequests(_repo: RepoRef): Promise<PrMeta[]> {
    return (
      this.opts.pulls ?? [
        {
          number: 482,
          title: 'Add rate limiting to public API endpoints',
          author: 'marisa.koch',
          branch: 'feat/rate-limit-public',
          base: 'main',
          head_sha: 'a1b2c3d4',
          additions: 247,
          deletions: 38,
          files_count: 9,
          status: 'open',
          opened_at: '2026-06-01T00:00:00Z',
          updated_at: '2026-06-01T03:00:00Z',
        },
      ]
    );
  }

  async getPullRequest(_repo: RepoRef, n: number): Promise<PrDetail> {
    const base: PrDetail = {
      number: n,
      title: 'Add rate limiting to public API endpoints',
      author: 'marisa.koch',
      branch: 'feat/rate-limit-public',
      base: 'main',
      head_sha: 'a1b2c3d4',
      additions: 247,
      deletions: 38,
      files_count: 9,
      status: 'open',
      body: 'Add rate limiting. Closes #471.',
      files: [
        {
          path: 'src/config.ts',
          additions: 4,
          deletions: 0,
          patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,',
        },
      ],
      commits: [
        { sha: 'a1b2c3d4', message: 'Add limiter', author: 'marisa.koch', committed_at: null },
      ],
      linked_issue: null,
    };
    return { ...base, ...this.opts.detail };
  }

  async postReview(_repo: RepoRef, n: number, review: GitHubReviewPayload): Promise<{ id: string }> {
    this.posted.push({ n, review });
    return { id: `mock-review-${n}` };
  }

  async listReviewComments(_repo: RepoRef, _n: number): Promise<PrReviewComment[]> {
    return this.opts.comments ?? [];
  }

  async createReviewComment(
    _repo: RepoRef,
    _n: number,
    input: CreateReviewCommentInput,
  ): Promise<PrReviewComment> {
    this.createdComments.push(input);
    return {
      id: this.createdComments.length,
      path: input.path,
      line: input.line,
      original_line: input.line,
      side: input.side ?? 'RIGHT',
      body: input.body,
      user: this.opts.login ?? 'mock-user',
      created_at: '2026-06-01T00:00:00Z',
      html_url: `https://github.com/mock/mock/pull/1#discussion_r${this.createdComments.length}`,
      in_reply_to_id: input.inReplyTo ?? null,
      is_outdated: false,
    };
  }

  async openPullRequest(_repo: RepoRef, payload: OpenPrPayload): Promise<{ url: string }> {
    this.openedPrs.push(payload);
    return { url: 'https://github.com/mock/mock/pull/1' };
  }

  async commitFiles(_repo: RepoRef, payload: CommitFilesPayload): Promise<{ branch: string }> {
    this.committed.push(payload);
    return { branch: payload.branch };
  }

  async findOpenPr(_repo: RepoRef, branch: string): Promise<{ url: string } | null> {
    const pr = this.openedPrs.find((p) => p.head === branch);
    return pr ? { url: 'https://github.com/mock/mock/pull/1' } : null;
  }

  async getIssue(_repo: RepoRef, n: number): Promise<IssueMeta> {
    return { number: n, title: `Issue #${n}`, body: 'mock issue', state: 'open' };
  }

  async currentLogin(): Promise<string> {
    return this.opts.login ?? 'mock-user';
  }
}

// ---------- Mock GitLab ----------
/** Endpoint kinds recorded by `MockGitLabClient.calls` (one entry per host request). */
export type MockGitLabCallKind =
  | 'project' //          GET /projects/:path
  | 'user' //             GET /user
  | 'token_scopes' //     GET /personal_access_tokens/self
  | 'merge_requests' //   GraphQL open-MR page (metadata + stats)
  | 'merge_request_states' // GraphQL iids:[…] state query
  | 'merge_request' //    GET /merge_requests/:iid
  | 'diffs' //            GET /merge_requests/:iid/diffs (one per page)
  | 'commits' //          GET /merge_requests/:iid/commits (one per page)
  | 'closes_issues' //    GET /merge_requests/:iid/closes_issues
  | 'issue'; //           GET /issues/:iid

export interface MockGitLabCall {
  kind: MockGitLabCallKind;
  fullPath?: string;
  n?: number;
}

export interface MockGitLabOptions {
  /** Open MRs returned by `listPullRequests` (default: one MR, iid 5). */
  pulls?: PrMetaHost[];
  /** Page size used only to record one `merge_requests` call per simulated page. */
  pageSize?: number;
  /** Current host state per iid for `getPullStates` (default: from `pulls`, else `merged`). */
  states?: Record<number, PrStatus>;
  /** Per-iid detail overrides (merged over a default built from `pulls`). */
  details?: Record<number, Partial<PrDetailHost>>;
  /** Detail override applied to every iid (after the default, before `details[n]`). */
  detail?: Partial<PrDetailHost>;
  /** Issues by iid; `null` ⇒ unavailable. Missing ⇒ a generated `Issue #n`. */
  issues?: Record<number, IssueMetaHost | null>;
  /** MR iid → same-project issue it closes. */
  linkedIssues?: Record<number, number | null>;
  /** Project returned by `getProject` (default: `path_with_namespace` = the requested path). */
  project?: Partial<GitLabProjectInfo>;
  tokenCheck?: GitLabTokenCheck;
  /** Throw this error from the first call of the given kind(s) — and every later one. */
  errors?: Partial<Record<MockGitLabCallKind, Error>>;
}

const MOCK_GITLAB_DEFAULT_MR: PrMetaHost = {
  number: 5,
  title: 'Add CRM contact import',
  author: 'olena.dev',
  branch: 'feat/contact-import',
  base: 'main',
  head_sha: 'f00dbabe5',
  additions: 120,
  deletions: 14,
  files_count: 6,
  stats_known: true,
  is_draft: false,
  status: 'open',
  opened_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
};

/**
 * Deterministic GitLabClient. `opts` is public so a test can mutate the host
 * (move a head SHA, un-draft an MR, inject an error) between calls. `calls`
 * records one entry per simulated host request, by endpoint kind.
 */
export class MockGitLabClient implements GitLabClient {
  readonly provider = 'gitlab' as const;
  readonly readOnly = true;
  public calls: MockGitLabCall[] = [];

  constructor(public opts: MockGitLabOptions = {}) {}

  /** Calls of one endpoint kind. */
  callsOf(kind: MockGitLabCallKind): MockGitLabCall[] {
    return this.calls.filter((c) => c.kind === kind);
  }

  private record(kind: MockGitLabCallKind, fullPath?: string, n?: number): void {
    this.calls.push({ kind, fullPath, n });
    const err = this.opts.errors?.[kind];
    if (err) throw err;
  }

  private pulls(): PrMetaHost[] {
    return this.opts.pulls ?? [MOCK_GITLAB_DEFAULT_MR];
  }

  async getProject(fullPath: string): Promise<GitLabProjectInfo> {
    this.record('project', fullPath);
    return {
      id: 1001,
      fullPath,
      defaultBranch: 'main',
      webUrl: `https://gitlab.com/${fullPath}`,
      ...this.opts.project,
    };
  }

  async checkToken(): Promise<GitLabTokenCheck> {
    this.record('user');
    const check = this.opts.tokenCheck ?? {
      ok: true,
      username: 'mock-gitlab-user',
      scopes: ['read_api', 'read_repository'],
      missingScopes: [],
    };
    if (check.ok) this.record('token_scopes');
    return check;
  }

  async listPullRequests(ref: HostRepoRef): Promise<PrMetaHost[]> {
    const pulls = this.pulls();
    const pageSize = this.opts.pageSize ?? 100;
    const pages = Math.max(1, Math.ceil(pulls.length / pageSize));
    for (let i = 0; i < pages; i++) this.record('merge_requests', ref.fullName);
    return pulls.map((p) => ({ ...p }));
  }

  async getPullStates(ref: HostRepoRef, numbers: number[]): Promise<PullStateInfo[]> {
    if (numbers.length === 0) return [];
    for (let i = 0; i < numbers.length; i += 100) this.record('merge_request_states', ref.fullName);
    const open = new Map(this.pulls().map((p) => [p.number, p.status] as const));
    return numbers.map((number) => ({
      number,
      status: this.opts.states?.[number] ?? open.get(number) ?? 'merged',
    }));
  }

  async getPullRequestDetail(
    ref: HostRepoRef,
    n: number,
    opts: PullDetailOptions = {},
  ): Promise<PullDetailResult> {
    this.record('merge_request', ref.fullName, n);
    const meta = this.pulls().find((p) => p.number === n) ?? { ...MOCK_GITLAB_DEFAULT_MR, number: n };
    const detail: PrDetailHost = {
      ...meta,
      stats_known: true,
      body: `Implements !${n}. Closes #12.`,
      files: [
        {
          path: 'src/import.ts',
          additions: 2,
          deletions: 0,
          patch: '@@ -1,1 +1,3 @@\n export {};\n+const a = 1;\n+const b = 2;',
          change_type: 'modified',
          previous_path: null,
          patch_omitted: null,
        },
      ],
      commits: [{ sha: meta.head_sha, message: 'Add import', author: meta.author, committed_at: null }],
      linked_issue: null,
      ...this.opts.detail,
      ...this.opts.details?.[n],
    };
    if (opts.unlessHeadSha && detail.head_sha && detail.head_sha === opts.unlessHeadSha) {
      const { body: _b, files: _f, commits: _c, linked_issue: _l, files_omitted_by_host: _o, ...rest } = detail;
      return {
        kind: 'unchanged',
        meta: { ...rest, additions: 0, deletions: 0, files_count: 0, stats_known: false },
      };
    }
    this.record('diffs', ref.fullName, n);
    this.record('commits', ref.fullName, n);
    const omitted = detail.files.filter((f) => f.patch_omitted).length;
    return {
      kind: 'full',
      detail: { ...detail, files_omitted_by_host: detail.files_omitted_by_host ?? omitted },
    };
  }

  async getIssue(ref: HostRepoRef, n: number): Promise<IssueMetaHost | null> {
    this.record('issue', ref.fullName, n);
    if (this.opts.issues && n in this.opts.issues) return this.opts.issues[n] ?? null;
    return { number: n, title: `Issue #${n}`, body: 'mock gitlab issue', state: 'open', labels: [] };
  }

  async getLinkedIssueNumber(ref: HostRepoRef, n: number): Promise<number | null> {
    this.record('closes_issues', ref.fullName, n);
    return this.opts.linkedIssues?.[n] ?? null;
  }
}

// ---------- Mock Git ----------
export interface MockGitOptions {
  diff?: string;
  files?: Record<string, string>;
  /** Name-only diff result (drives the incremental indexer's "changed files since X" path). */
  diffNameOnly?: string[];
  /** Override `currentHead()` so tests can simulate "sha unchanged since last index". */
  head?: string;
  /** Head `currentHead()` returns AFTER `sync()` runs — simulates fetch+reset advancing HEAD. */
  syncedHead?: string;
}

export class MockGitClient implements HostGitClient {
  public cloned: { repo: HostRepoRef; url: string }[] = [];
  public syncs: { repo: HostRepoRef; branch: string }[] = [];
  /** Every `fetchPullHead` call (GitLab review diffs fetch the MR head ref). */
  public pullHeadFetches: { repo: HostRepoRef; n: number }[] = [];
  private syncedHead?: string;

  constructor(private opts: MockGitOptions = {}) {}

  /**
   * Mirrors `SimpleGitClient.clonePathFor`: GitHub (no provider / `github`) →
   * `<root>/<owner>/<name>` (unchanged); GitLab →
   * `<root>/@gitlab.com/<namespace…>/<name>`, so the same path on both hosts
   * never shares a clone (AC-15).
   */
  clonePathFor(repo: HostRepoRef): string {
    if (repo.provider === 'gitlab') {
      return `/mock/clones/@gitlab.com/${repo.owner}/${repo.name}`;
    }
    return `/mock/clones/${repo.owner}/${repo.name}`;
  }
  async clone(repo: HostRepoRef, url: string, _opts?: CloneOptions): Promise<{ path: string }> {
    this.cloned.push({ repo, url });
    return { path: this.clonePathFor(repo) };
  }
  async fetchPullHead(repo: HostRepoRef, n: number, _opts?: FetchPullHeadOptions): Promise<void> {
    this.pullHeadFetches.push({ repo, n });
  }
  async sync(repo: HostRepoRef, branch: string): Promise<{ head: string }> {
    this.syncs.push({ repo, branch });
    // After a sync, HEAD advances to syncedHead (or stays at head if unset).
    this.syncedHead = this.opts.syncedHead ?? this.opts.head ?? 'a1b2c3d4';
    return { head: this.syncedHead };
  }
  async currentHead(): Promise<string> {
    return this.syncedHead ?? this.opts.head ?? 'a1b2c3d4';
  }
  async diffNameOnly(): Promise<string[]> {
    return this.opts.diffNameOnly ?? [];
  }
  async diff(): Promise<UnifiedDiff> {
    const raw =
      this.opts.diff ??
      'diff --git a/src/config.ts b/src/config.ts\n--- a/src/config.ts\n+++ b/src/config.ts\n@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,';
    return parseUnifiedDiff(raw);
  }
  async blame(): Promise<BlameLine[]> {
    return [{ line: 1, sha: 'a1b2c3d4', author: 'marisa.koch', date: '2026-06-01', summary: 'init' }];
  }
  async log(): Promise<GitCommit[]> {
    return [{ sha: 'a1b2c3d4', message: 'init', author: 'marisa.koch', date: '2026-06-01' }];
  }
  async readFile(_repo: HostRepoRef, path: string): Promise<string> {
    return this.opts.files?.[path] ?? '';
  }
}

// ---------- Mock CodeIndex ----------
export class MockCodeIndex implements CodeIndex {
  async grep(_repo: RepoRef, pattern: string): Promise<CodeMatch[]> {
    return [{ path: 'src/config.ts', line: 12, text: `match for ${pattern}` }];
  }
  async symbols(): Promise<CodeSymbol[]> {
    return [{ path: 'src/middleware/ratelimit.ts', name: 'rateLimit', kind: 'function', line: 25 }];
  }
  async references(_repo: RepoRef, symbol: string): Promise<CodeReference[]> {
    return [{ fromPath: 'src/api/public/index.ts', toSymbol: symbol, line: 23 }];
  }
}

// ---------- Mock Auth / Secrets ----------
export class MockAuthProvider implements AuthProvider {
  constructor(
    private user: AuthUser = { id: 'u1', email: 'you@local', name: 'You' },
    private workspace: AuthWorkspace = { id: 'w1', name: 'default' },
  ) {}
  async currentUser(): Promise<AuthUser> {
    return this.user;
  }
  async currentWorkspace(): Promise<AuthWorkspace> {
    return this.workspace;
  }
}

export class MockSecretsProvider implements SecretsProvider {
  constructor(private secrets: Partial<Record<string, string>> = {}) {}
  async get(key: SecretKey): Promise<string | undefined> {
    return this.secrets[key as string];
  }
}

// ---------- Mock identity provider (Google OIDC stand-in) ----------
/**
 * `idp_down` — `exchangeCode` throws `auth_idp_unavailable` (AC-15).
 * `bad_token` — `verifyIdToken` throws `auth_token_invalid` (AC-8).
 */
export type MockIdpFailure = 'idp_down' | 'bad_token';

export type MockIdpCall =
  | { kind: 'authorizationUrl'; input: AuthorizationUrlInput }
  | { kind: 'exchangeCode'; input: CodeExchangeInput }
  | { kind: 'verifyIdToken'; input: VerifyIdTokenInput };

export interface MockIdentityProviderOptions {
  /** Default identity returned for any code without a scripted one. */
  identity?: Partial<VerifiedIdentity>;
  failure?: MockIdpFailure | null;
  /**
   * When true (default), `verifyIdToken` rejects a nonce that was never issued
   * through `authorizationUrl` — mirrors Google echoing the request nonce.
   * Set false to call the callback flow without a prior `authorizationUrl`.
   */
  enforceNonce?: boolean;
}

export const MOCK_IDP_AUTHORIZE_URL = 'https://idp.mock.invalid/authorize';
const MOCK_ID_TOKEN_PREFIX = 'mock-id-token.';

export const DEFAULT_MOCK_IDENTITY: VerifiedIdentity = {
  subject: 'google-sub-1',
  email: 'alice@onlytraf.com',
  emailVerified: true,
  hostedDomain: 'onlytraf.com',
  name: 'Alice Example',
  avatarUrl: null,
};

/**
 * Scriptable, network-free `IdentityProvider`. The "ID token" returned by
 * `exchangeCode` is `mock-id-token.<code>`; `verifyIdToken` maps it back to the
 * identity scripted for that code (`scriptCode`) or the default identity.
 * Every call is recorded in `calls`.
 */
export class MockIdentityProvider implements IdentityProvider {
  readonly calls: MockIdpCall[] = [];
  private identity: VerifiedIdentity;
  private failure: MockIdpFailure | null;
  private readonly enforceNonce: boolean;
  private readonly byCode = new Map<string, VerifiedIdentity>();
  private readonly issuedNonces = new Set<string>();

  constructor(options: MockIdentityProviderOptions = {}) {
    this.identity = { ...DEFAULT_MOCK_IDENTITY, ...options.identity };
    this.failure = options.failure ?? null;
    this.enforceNonce = options.enforceNonce ?? true;
  }

  /** Replace (merge into the default) the identity returned for unscripted codes. */
  setIdentity(identity: Partial<VerifiedIdentity>): this {
    this.identity = { ...DEFAULT_MOCK_IDENTITY, ...identity };
    return this;
  }

  /** Script the identity returned for one authorization code. */
  scriptCode(code: string, identity: Partial<VerifiedIdentity>): this {
    this.byCode.set(code, { ...DEFAULT_MOCK_IDENTITY, ...identity });
    return this;
  }

  /** Set (or clear with `null`) the failure mode. */
  fail(mode: MockIdpFailure | null): this {
    this.failure = mode;
    return this;
  }

  callsOf<K extends MockIdpCall['kind']>(kind: K): Extract<MockIdpCall, { kind: K }>[] {
    return this.calls.filter((c): c is Extract<MockIdpCall, { kind: K }> => c.kind === kind);
  }

  readonly authorizationUrl = (input: AuthorizationUrlInput): string => {
    this.calls.push({ kind: 'authorizationUrl', input: { ...input } });
    this.issuedNonces.add(input.nonce);
    const url = new URL(MOCK_IDP_AUTHORIZE_URL);
    url.searchParams.set('state', input.state);
    url.searchParams.set('nonce', input.nonce);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  };

  readonly exchangeCode = async (input: CodeExchangeInput): Promise<CodeExchangeResult> => {
    this.calls.push({ kind: 'exchangeCode', input: { ...input } });
    if (this.failure === 'idp_down') throw new AuthFlowError('auth_idp_unavailable');
    return { idToken: MOCK_ID_TOKEN_PREFIX + input.code };
  };

  readonly verifyIdToken = async (input: VerifyIdTokenInput): Promise<VerifiedIdentity> => {
    this.calls.push({ kind: 'verifyIdToken', input: { ...input } });
    if (this.failure === 'idp_down') throw new AuthFlowError('auth_idp_unavailable');
    if (this.failure === 'bad_token') throw new AuthFlowError('auth_token_invalid');
    if (!input.idToken.startsWith(MOCK_ID_TOKEN_PREFIX)) {
      throw new AuthFlowError('auth_token_invalid');
    }
    if (this.enforceNonce && !this.issuedNonces.has(input.nonce)) {
      throw new AuthFlowError('auth_token_invalid');
    }
    const code = input.idToken.slice(MOCK_ID_TOKEN_PREFIX.length);
    return { ...(this.byCode.get(code) ?? this.identity) };
  };
}
