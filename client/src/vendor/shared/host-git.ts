import type {
  BlameLine,
  CloneOptions,
  GitClient,
  GitCommit,
  UnifiedDiff,
} from './adapters.js';
import type { HostRepoRef } from './host-adapters.js';

/**
 * Host-aware git port (GitHub + GitLab). ADDITIVE — `adapters.ts` is not edited:
 * the plain `GitClient` keeps taking `RepoRef` for compatibility, while this
 * extension narrows every repo parameter to `HostRepoRef` (the clone path, the
 * remote URL and the credential scope all depend on the provider) and declares
 * the optional `{ base }` of `fetchPullHead` (GitLab also fetches the target
 * branch so a merge-base is reachable in the shallow clone).
 *
 * A `HostGitClient` is assignable wherever a `GitClient` is expected.
 */
export interface FetchPullHeadOptions {
  /** Target branch to fetch alongside the PR/MR head (GitLab). */
  base?: string;
}

export interface HostGitClient extends GitClient {
  clone(repo: HostRepoRef, url: string, opts?: CloneOptions): Promise<{ path: string }>;
  fetchPullHead(repo: HostRepoRef, n: number, opts?: FetchPullHeadOptions): Promise<void>;
  sync(repo: HostRepoRef, branch: string): Promise<{ head: string }>;
  currentHead(repo: HostRepoRef): Promise<string>;
  diff(repo: HostRepoRef, base: string, head: string): Promise<UnifiedDiff>;
  diffNameOnly(repo: HostRepoRef, base: string, head: string): Promise<string[]>;
  blame(repo: HostRepoRef, path: string): Promise<BlameLine[]>;
  log(repo: HostRepoRef, path?: string): Promise<GitCommit[]>;
  readFile(repo: HostRepoRef, path: string): Promise<string>;
  clonePathFor(repo: HostRepoRef): string;
}
