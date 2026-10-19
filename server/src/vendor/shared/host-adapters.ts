import type { PrStatus } from './contracts/platform.js';
import type {
  IssueMetaHost,
  PrDetailHost,
  PrMetaHost,
  RepoHost,
  RepoProvider,
} from './contracts/repo-host.js';
import type { RepoRef } from './adapters.js';

/**
 * Host-neutral adapter ports (GitHub + GitLab). ADDITIVE — `adapters.ts` is not
 * edited: `GitHubClient` / `GitClient` keep taking `RepoRef`, and
 * `HostRepoRef` is a structural subtype that passes straight through them.
 */

// ---------- Host repo reference ----------
/**
 * A provider-neutral repo reference able to carry a nested GitLab path.
 * For GitLab `owner` is the full namespace (may contain `/`), `name` the
 * project segment and `fullName` the whole project path.
 */
export interface HostRepoRef extends RepoRef {
  provider: RepoProvider;
  host: RepoHost;
  fullName: string;
}

// ---------- Read-side PR/MR host (named after the conversation, not the vendor) ----------
/** Current state of one PR/MR (used to reconcile ones that left the open set). */
export interface PullStateInfo {
  number: number;
  status: PrStatus;
}

export interface PullDetailOptions {
  /**
   * When the host's current head SHA equals this value, the adapter may skip the
   * diff/commit fetch and return `{ kind: 'unchanged' }`.
   */
  unlessHeadSha?: string | null;
}

export type PullDetailResult =
  | { kind: 'full'; detail: PrDetailHost }
  | { kind: 'unchanged'; meta: PrMetaHost };

export interface PullRequestHost {
  readonly provider: RepoProvider;
  /** true ⇒ no write path (comments, reviews) exists for this host in the MVP. */
  readonly readOnly: boolean;
  listPullRequests(ref: HostRepoRef): Promise<PrMetaHost[]>;
  getPullStates(ref: HostRepoRef, numbers: number[]): Promise<PullStateInfo[]>;
  getPullRequestDetail(
    ref: HostRepoRef,
    n: number,
    opts?: PullDetailOptions,
  ): Promise<PullDetailResult>;
  /** null when the issue is unavailable (missing, confidential, no access). */
  getIssue(ref: HostRepoRef, n: number): Promise<IssueMetaHost | null>;
  /** Issue the PR/MR closes in the SAME project, if any. */
  getLinkedIssueNumber(ref: HostRepoRef, n: number): Promise<number | null>;
}

// ---------- GitLab ----------
export interface GitLabProjectInfo {
  id: number;
  /** Canonical `path_with_namespace` (authoritative casing). */
  fullPath: string;
  defaultBranch: string;
  webUrl: string;
}

export type GitLabTokenFailure = 'invalid' | 'expired' | 'revoked';

export type GitLabTokenCheck =
  | {
      ok: true;
      username: string;
      /** null ⇒ scopes could not be introspected for this token type. */
      scopes: string[] | null;
      /** Required read scopes the token lacks (empty when sufficient or unknown). */
      missingScopes: string[];
    }
  | { ok: false; reason: GitLabTokenFailure };

export interface GitLabClient extends PullRequestHost {
  readonly provider: 'gitlab';
  getProject(fullPath: string): Promise<GitLabProjectInfo>;
  checkToken(): Promise<GitLabTokenCheck>;
}

// ---------- Git credentials (per-invocation, never in URLs or .git/config) ----------
export interface GitCredential {
  username: string;
  token: string;
}

/** Resolves the credential for one git network op; null ⇒ run unauthenticated. */
export type GitCredentialResolver = (ref: HostRepoRef) => Promise<GitCredential | null>;
