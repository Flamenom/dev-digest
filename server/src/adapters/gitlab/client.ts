import type {
  GitLabClient,
  GitLabProjectInfo,
  GitLabTokenCheck,
  HostRepoRef,
  IssueMetaHost,
  PrDetailHost,
  PrMetaHost,
  PullDetailOptions,
  PullDetailResult,
  PullStateInfo,
} from '@devdigest/shared';
import { AppError, NotFoundError } from '../../platform/errors.js';
import { GitLabHttp, GitLabHttpError, type GitLabHttpOptions, type QueryValue } from './http.js';
import {
  GITLAB_PAGE_SIZE,
  MERGE_REQUEST_STATES_QUERY,
  MERGE_REQUEST_STATS_QUERY,
  OPEN_MERGE_REQUESTS_QUERY,
  type GqlMergeRequestStatesData,
  type GqlMergeRequestStatsData,
  type GqlOpenMergeRequestsData,
} from './graphql.js';
import {
  mapDiffStats,
  mapGqlMergeRequest,
  mapMrState,
  mapRestCommit,
  mapRestDiff,
  mapRestIssue,
  mapRestMergeRequestMeta,
  mapRestProject,
  missingScopes,
  restHeadSha,
  tokenFailureReason,
  type RestCommit,
  type RestDiff,
  type RestIssue,
  type RestMergeRequest,
  type RestProject,
  type RestTokenSelf,
  type RestUser,
} from './mappers.js';

export type RestGitLabClientOptions = GitLabHttpOptions;

/**
 * GitLabClient for gitlab.com — REST v4 for project/MR detail/diffs/commits/
 * issues/token, GraphQL for the open-MR list (metadata + batched stats in one
 * request per page). Read-only in the MVP.
 *
 * Requests are issued strictly sequentially (≤ 1 in flight per call chain).
 * Every list call is paginated to the end with no cap (AC-22).
 *
 * Constructed ONLY by the composition root (`platform/container.ts`).
 */
export class RestGitLabClient implements GitLabClient {
  readonly provider = 'gitlab' as const;
  readonly readOnly = true;

  private readonly http: GitLabHttp;
  /** fullPath → numeric project id (for the same-project `closes_issues` filter). */
  private readonly projectIds = new Map<string, number>();

  constructor(opts: RestGitLabClientOptions = {}) {
    this.http = new GitLabHttp(opts);
  }

  // ---------- project / token ----------

  async getProject(fullPath: string): Promise<GitLabProjectInfo> {
    try {
      const { data } = await this.http.rest<RestProject>(`/projects/${encodeProject(fullPath)}`);
      const info = mapRestProject(data);
      this.projectIds.set(fullPath.toLowerCase(), info.id);
      return info;
    } catch (err) {
      throw this.projectError(err);
    }
  }

  async checkToken(): Promise<GitLabTokenCheck> {
    if (!this.http.hasToken) return { ok: false, reason: 'invalid' };

    let username: string;
    try {
      const { data } = await this.http.rest<RestUser>('/user');
      username = typeof data?.username === 'string' ? data.username : '';
    } catch (err) {
      if (err instanceof GitLabHttpError && (err.upstreamStatus === 401 || err.upstreamStatus === 403)) {
        return { ok: false, reason: tokenFailureReason(err.upstreamDetail) };
      }
      throw err;
    }

    try {
      const { data } = await this.http.rest<RestTokenSelf>('/personal_access_tokens/self');
      if (!Array.isArray(data?.scopes)) return { ok: true, username, scopes: null, missingScopes: [] };
      const scopes = data.scopes.filter((s): s is string => typeof s === 'string');
      return { ok: true, username, scopes, missingScopes: missingScopes(scopes) };
    } catch (err) {
      // Token types that cannot introspect themselves (404/403) — or any other
      // host failure here — degrade to "scopes unknown" (AC-5).
      if (err instanceof GitLabHttpError) return { ok: true, username, scopes: null, missingScopes: [] };
      throw err;
    }
  }

  // ---------- PullRequestHost ----------

  async listPullRequests(ref: HostRepoRef): Promise<PrMetaHost[]> {
    const fullPath = projectPath(ref);
    const byNumber = new Map<number, PrMetaHost>();
    let after: string | null = null;
    for (;;) {
      const data: GqlOpenMergeRequestsData = await this.gql<GqlOpenMergeRequestsData>(
        OPEN_MERGE_REQUESTS_QUERY,
        { fullPath, first: GITLAB_PAGE_SIZE, after },
      );
      if (!data.project) throw this.projectNotVisible();
      const conn = data.project.mergeRequests;
      if (!conn) break;
      for (const node of conn.nodes) {
        const meta = node ? mapGqlMergeRequest(node) : null;
        if (meta) byNumber.set(meta.number, meta);
      }
      const next = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
      if (!next || next === after) break;
      after = next;
    }
    return [...byNumber.values()];
  }

  async getPullStates(ref: HostRepoRef, numbers: number[]): Promise<PullStateInfo[]> {
    const fullPath = projectPath(ref);
    const unique = [...new Set(numbers.filter((n) => Number.isInteger(n) && n > 0))];
    const out: PullStateInfo[] = [];
    for (let i = 0; i < unique.length; i += GITLAB_PAGE_SIZE) {
      const chunk = unique.slice(i, i + GITLAB_PAGE_SIZE);
      const data = await this.gql<GqlMergeRequestStatesData>(MERGE_REQUEST_STATES_QUERY, {
        fullPath,
        iids: chunk.map(String),
        first: chunk.length,
      });
      if (!data.project) throw this.projectNotVisible();
      for (const node of data.project.mergeRequests?.nodes ?? []) {
        const number = Number(node?.iid);
        if (!node || !Number.isInteger(number)) continue;
        out.push({ number, status: mapMrState(node.state) });
      }
    }
    return out;
  }

  /**
   * `kind:'unchanged'` when the host head equals `unlessHeadSha` — then no diff
   * or commit request is made and `meta` carries NO line stats
   * (`stats_known:false`): the caller keeps its persisted stats.
   */
  async getPullRequestDetail(
    ref: HostRepoRef,
    n: number,
    opts: PullDetailOptions = {},
  ): Promise<PullDetailResult> {
    const fullPath = projectPath(ref);
    const mrPath = `/projects/${encodeProject(fullPath)}/merge_requests/${mrIid(n)}`;

    let mr: RestMergeRequest;
    try {
      mr = (await this.http.rest<RestMergeRequest>(mrPath)).data;
    } catch (err) {
      throw this.commonError(err, () => new NotFoundError(`Merge request !${n} not found on GitLab`));
    }

    const headSha = restHeadSha(mr);
    if (opts.unlessHeadSha && headSha && headSha === opts.unlessHeadSha) {
      return { kind: 'unchanged', meta: mapRestMergeRequestMeta(mr) };
    }

    try {
      const files = (await this.paginate<RestDiff>(`${mrPath}/diffs`)).map(mapRestDiff);
      // GitLab lists MR commits newest-first; GitHub (and the UI) use oldest-first.
      const commits = (await this.paginate<RestCommit>(`${mrPath}/commits`)).map(mapRestCommit).reverse();

      const omitted = files.filter((f) => f.patch_omitted).length;
      let additions = files.reduce((s, f) => s + f.additions, 0);
      let deletions = files.reduce((s, f) => s + f.deletions, 0);
      let statsKnown = true;
      if (omitted > 0) {
        // Line counts of withheld patches are unknown — ask GitLab for the exact summary.
        const summary = await this.mergeRequestStats(fullPath, n);
        if (summary.stats_known) {
          additions = summary.additions;
          deletions = summary.deletions;
        } else {
          statsKnown = false;
        }
      }

      const meta = mapRestMergeRequestMeta(mr, {
        additions,
        deletions,
        files_count: files.length,
        stats_known: statsKnown,
      });
      const detail: PrDetailHost = {
        ...meta,
        body: mr.description ?? null,
        files,
        commits,
        linked_issue: null,
        files_omitted_by_host: omitted,
      };
      return { kind: 'full', detail };
    } catch (err) {
      throw this.commonError(err);
    }
  }

  async getIssue(ref: HostRepoRef, n: number): Promise<IssueMetaHost | null> {
    const fullPath = projectPath(ref);
    try {
      const { data } = await this.http.rest<RestIssue>(
        `/projects/${encodeProject(fullPath)}/issues/${mrIid(n)}`,
      );
      return mapRestIssue(data);
    } catch (err) {
      if (isStatus(err, 403, 404)) return null; // missing, confidential or no access
      throw this.commonError(err);
    }
  }

  async getLinkedIssueNumber(ref: HostRepoRef, n: number): Promise<number | null> {
    const fullPath = projectPath(ref);
    try {
      const projectId = await this.projectId(fullPath);
      const issues = await this.paginate<RestIssue>(
        `/projects/${encodeProject(fullPath)}/merge_requests/${mrIid(n)}/closes_issues`,
      );
      // Same project only (AC-23): a cross-project "closes" never becomes the linked issue.
      const hit = issues.find((i) => i.project_id === projectId && Number.isInteger(i.iid));
      return hit ? hit.iid : null;
    } catch (err) {
      if (isStatus(err, 403, 404)) return null;
      throw this.commonError(err);
    }
  }

  // ---------- internals ----------

  private async projectId(fullPath: string): Promise<number> {
    const cached = this.projectIds.get(fullPath.toLowerCase());
    if (cached !== undefined) return cached;
    return (await this.getProject(fullPath)).id;
  }

  private async mergeRequestStats(fullPath: string, n: number) {
    const data = await this.gql<GqlMergeRequestStatsData>(MERGE_REQUEST_STATS_QUERY, {
      fullPath,
      iid: String(n),
    });
    return mapDiffStats(data.project?.mergeRequest?.diffStatsSummary);
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    try {
      return await this.http.graphql<T>(query, variables);
    } catch (err) {
      throw this.commonError(err);
    }
  }

  /** GET every page of a REST list (`x-next-page`), no upper limit (AC-22). */
  private async paginate<T>(path: string, query: Record<string, QueryValue> = {}): Promise<T[]> {
    const out: T[] = [];
    let page = 1;
    for (;;) {
      const { data, headers } = await this.http.rest<T[]>(path, {
        ...query,
        per_page: GITLAB_PAGE_SIZE,
        page,
      });
      const items = Array.isArray(data) ? data : [];
      out.push(...items);
      const header = headers.get('x-next-page');
      let next: number | null;
      if (header === null) {
        // Header absent: fall back to "a full page means there may be more".
        next = items.length === GITLAB_PAGE_SIZE ? page + 1 : null;
      } else {
        const parsed = Number(header.trim());
        next = header.trim() && Number.isInteger(parsed) ? parsed : null;
      }
      if (next === null || next <= page || items.length === 0) break;
      page = next;
    }
    return out;
  }

  private tokenInvalid(): AppError {
    return new AppError(
      'gitlab_token_invalid',
      'GitLab rejected the token (invalid, expired or revoked). Update it in Settings → API keys.',
      400,
    );
  }

  /** 404 on a project: private/missing without a token (AC-13) vs no access with one (AC-14). */
  private projectNotVisible(): AppError {
    if (!this.http.hasToken) {
      return new AppError(
        'gitlab_token_missing',
        'Connect a GitLab token in Settings → API keys: this gitlab.com project is private or does not exist.',
        400,
      );
    }
    return new AppError('gitlab_project_inaccessible', 'GitLab project not found or token has no access.', 404);
  }

  private projectError(err: unknown): unknown {
    if (isStatus(err, 403, 404)) return this.projectNotVisible();
    return this.commonError(err);
  }

  /** Map host failures to domain errors; everything else passes through (already redacted). */
  private commonError(err: unknown, onNotFound?: () => AppError): unknown {
    if (err instanceof AppError && !(err instanceof GitLabHttpError)) return err;
    if (isStatus(err, 401)) return this.tokenInvalid();
    if (onNotFound && isStatus(err, 404)) return onNotFound();
    return err;
  }
}

// ---------- helpers ----------

function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof GitLabHttpError && statuses.includes(err.upstreamStatus);
}

/** REST project id: the full path URL-encoded as ONE segment (`a/b/c` → `a%2Fb%2Fc`). */
export function encodeProject(fullPath: string): string {
  const trimmed = fullPath.trim();
  if (!trimmed) throw new AppError('validation_error', 'GitLab project path is empty', 422);
  return encodeURIComponent(trimmed);
}

function projectPath(ref: HostRepoRef): string {
  if (ref.provider && ref.provider !== 'gitlab') {
    throw new AppError('unsupported_repo_host', `Not a GitLab repository: ${ref.provider}`, 400);
  }
  return ref.fullName || `${ref.owner}/${ref.name}`;
}

function mrIid(n: number): number {
  if (!Number.isInteger(n) || n <= 0) {
    throw new AppError('validation_error', `Invalid GitLab IID: ${n}`, 422);
  }
  return n;
}
