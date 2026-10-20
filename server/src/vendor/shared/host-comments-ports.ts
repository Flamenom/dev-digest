import type { GitLabTokenFailure, HostRepoRef } from './host-adapters.js';

/**
 * GitLab diff-discussion port (spec `specs/2026-10-20-gitlab-comments.md`).
 * ADDITIVE — no existing port is edited. Named after the conversation (diff
 * discussions), not the vendor client; `RestGitLabClient` implements it next to
 * `GitLabClient`.
 *
 * Every member is a FUNCTION-TYPED PROPERTY, not a method, so
 * `strictFunctionTypes` checks parameters contravariantly (see `host-git.ts`).
 */

/** The MR's current diff SHAs (GitLab `diff_refs`). */
export interface GitLabDiffRefs {
  baseSha: string;
  startSha: string;
  headSha: string;
}

/** A `text` diff position for a new discussion. A context line sets both lines. */
export interface GitLabTextPosition {
  baseSha: string;
  startSha: string;
  headSha: string;
  oldPath: string;
  newPath: string;
  oldLine: number | null;
  newLine: number | null;
}

/** One note of a diff-anchored, text-positioned discussion. */
export interface GitLabDiffNote {
  id: number;
  discussionId: string;
  /** Id of the discussion's first note (equals `id` for the root). */
  rootNoteId: number;
  author: string;
  body: string;
  createdAt: string;
  position: {
    headSha: string;
    oldPath: string | null;
    newPath: string | null;
    oldLine: number | null;
    newLine: number | null;
  };
}

/** A discussion looked up before replying (existence + root note id). */
export interface GitLabDiscussionRef {
  id: string;
  rootNoteId: number;
  position: GitLabDiffNote['position'] | null;
}

/**
 * Result of the token scope lookup. `unverified` ⇒ scopes could not be
 * determined because of a transient failure (AC-28).
 */
export type GitLabScopeCheck =
  | { kind: 'ok'; username: string; scopes: string[] }
  | { kind: 'insufficient_scope'; username: string | null }
  | { kind: 'invalid'; reason: GitLabTokenFailure }
  | { kind: 'unverified' };

export interface GitLabCommentsHost {
  /** Every note of every diff-anchored text discussion, across all pages. */
  listDiffNotes: (ref: HostRepoRef, iid: number) => Promise<GitLabDiffNote[]>;
  /** The MR's current diff refs. */
  getDiffRefs: (ref: HostRepoRef, iid: number) => Promise<GitLabDiffRefs>;
  /** null when the discussion does not exist on this MR. */
  getDiscussion: (
    ref: HostRepoRef,
    iid: number,
    discussionId: string,
  ) => Promise<GitLabDiscussionRef | null>;
  createDiffDiscussion: (
    ref: HostRepoRef,
    iid: number,
    input: { body: string; position: GitLabTextPosition },
  ) => Promise<GitLabDiffNote>;
  addDiscussionNote: (
    ref: HostRepoRef,
    iid: number,
    discussionId: string,
    body: string,
  ) => Promise<GitLabDiffNote>;
  checkTokenScopes: () => Promise<GitLabScopeCheck>;
}
