import type {
  BlameLine,
  CloneOptions,
  CodeMatch,
  CodeReference,
  CodeSymbol,
  GitCommit,
  UnifiedDiff,
} from './adapters.js';
import type { HostRepoRef } from './host-adapters.js';

/**
 * Host-aware git port (GitHub + GitLab). ADDITIVE — `adapters.ts` is not edited:
 * the legacy `GitClient` keeps taking `RepoRef`, while this port requires a
 * `HostRepoRef` for every repo parameter (the clone path, the remote URL and
 * the credential scope all depend on the provider) and declares the optional
 * `{ base }` of `fetchPullHead` (GitLab also fetches the target branch so a
 * merge-base is reachable in the shallow clone).
 *
 * Soundness: every member is a FUNCTION-TYPED PROPERTY, not a method, so
 * `strictFunctionTypes` checks its parameters contravariantly — a consumer typed
 * against this port cannot be handed a plain `{ owner, name }` `RepoRef`, and a
 * narrower view (`Pick<HostGitClient, 'readFile'>`) keeps that guarantee.
 * It deliberately does NOT extend `GitClient`: narrowing a method parameter
 * from `RepoRef` to `HostRepoRef` is only accepted through method bivariance,
 * and would let a `GitClient`-typed consumer pass a ref without a provider.
 *
 * It is NOT a drop-in `GitClient`. TypeScript still accepts the upcast
 * `const g: GitClient = hostGit` (the legacy port's members are METHODS, so the
 * target side is compared bivariantly) — that upcast is unsound and must not be
 * written. Consumers of the container's git type against `HostGitClient` (or a
 * `Pick` of it) and build refs with `hostRepoRef(row)`.
 */
export interface FetchPullHeadOptions {
  /** Target branch to fetch alongside the PR/MR head (GitLab). */
  base?: string;
}

export interface HostGitClient {
  clone: (repo: HostRepoRef, url: string, opts?: CloneOptions) => Promise<{ path: string }>;
  fetchPullHead: (repo: HostRepoRef, n: number, opts?: FetchPullHeadOptions) => Promise<void>;
  /**
   * Resync an already-cloned repo to the tip of `branch` (fetch + advance the
   * local working tree to `origin/<branch>`). Returns the new HEAD sha.
   */
  sync: (repo: HostRepoRef, branch: string) => Promise<{ head: string }>;
  currentHead: (repo: HostRepoRef) => Promise<string>;
  diff: (repo: HostRepoRef, base: string, head: string) => Promise<UnifiedDiff>;
  /** `git diff --name-only base..head` (two-dot, see `GitClient.diffNameOnly`). */
  diffNameOnly: (repo: HostRepoRef, base: string, head: string) => Promise<string[]>;
  blame: (repo: HostRepoRef, path: string) => Promise<BlameLine[]>;
  log: (repo: HostRepoRef, path?: string) => Promise<GitCommit[]>;
  readFile: (repo: HostRepoRef, path: string) => Promise<string>;
  clonePathFor: (repo: HostRepoRef) => string;
}

/**
 * Host-aware code index over a local clone. Same shape as `CodeIndex`, but the
 * clone it searches is resolved through `HostGitClient.clonePathFor`, so it
 * needs a `HostRepoRef` (a GitLab clone lives under a different root). Function
 * properties for the same strictness reason as `HostGitClient`. Any legacy
 * `CodeIndex` (taking the wider `RepoRef`) is assignable to it.
 */
export interface HostCodeIndex {
  grep: (repo: HostRepoRef, pattern: string) => Promise<CodeMatch[]>;
  symbols: (repo: HostRepoRef) => Promise<CodeSymbol[]>;
  references: (repo: HostRepoRef, symbol: string) => Promise<CodeReference[]>;
}
