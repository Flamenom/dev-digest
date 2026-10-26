import type { HostRepoRef } from './host-adapters.js';
import type { PrFileHost } from './contracts/repo-host.js';

/**
 * GitLab MR diff-versions port (spec
 * `specs/2026-10-23-gitlab-publish-outdated-findings.md`). ADDITIVE — no
 * existing port is edited. Named after the conversation (the MR's diff
 * versions), not the vendor client; `RestGitLabClient` implements it.
 *
 * Every member is a FUNCTION-TYPED PROPERTY, not a method, so
 * `strictFunctionTypes` checks parameters contravariantly (see `host-git.ts`).
 */

/** One MR diff version (`GET …/merge_requests/:iid/versions`). */
export interface GitLabMrDiffVersion {
  id: number;
  headSha: string;
  baseSha: string;
  startSha: string;
  createdAt: string;
}

export interface GitLabDiffVersionsHost {
  /**
   * The MR's diff versions, at most `maxPages` pages; `truncated` ⇒ more pages
   * existed. Read policy; throws a mapped AppError.
   */
  listMrDiffVersions: (
    ref: HostRepoRef,
    iid: number,
    opts: { maxPages: number },
  ) => Promise<{ versions: GitLabMrDiffVersion[]; truncated: boolean }>;
  /** The files of one diff version, mapped like the MR diff. Read policy; throws a mapped AppError. */
  getMrDiffVersionFiles: (
    ref: HostRepoRef,
    iid: number,
    versionId: number,
  ) => Promise<PrFileHost[]>;
}
