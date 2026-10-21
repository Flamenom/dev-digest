import type { HostRepoRef } from './host-adapters.js';
import type { GitLabTextPosition } from './host-comments-ports.js';

/**
 * GitLab draft-review port (spec `specs/2026-10-21-gitlab-publish-findings.md`).
 * ADDITIVE — no existing port is edited. Named after the conversation (a draft
 * review: draft notes + bulk publish), not the vendor client; `RestGitLabClient`
 * implements it next to `GitLabClient` and `GitLabCommentsHost`.
 *
 * Every member is a FUNCTION-TYPED PROPERTY, not a method, so
 * `strictFunctionTypes` checks parameters contravariantly (see `host-git.ts`).
 */

/** Shared, mutable 429 wait budget of one publication (AC-28). */
export interface WaitBudget {
  remainingMs: number;
}

/** A text position with an optional multi-line range (AC-11). */
export type GitLabDraftPosition = GitLabTextPosition & {
  lineRange?: {
    start: { oldLine: number | null; newLine: number | null };
    end: { oldLine: number | null; newLine: number | null };
  };
};

/** One of the token user's draft notes on an MR. */
export interface GitLabDraftNote {
  id: number;
  note: string;
}

/** One non-system note of any MR discussion (diff or general). */
export interface GitLabMrNote {
  id: number;
  discussionId: string;
  author: string;
  body: string;
  system: boolean;
}

/**
 * Why a write did not (provably) land. `rejected` = a definitive 4xx (400/422);
 * `unconfirmed` = 5xx / timeout / network — the write may have landed.
 */
export type GitLabWriteFailure =
  | { kind: 'rejected'; status: number }
  | { kind: 'rate_limited' }
  | { kind: 'token_invalid' }
  | { kind: 'insufficient_scope' }
  | { kind: 'forbidden' }
  | { kind: 'not_found' }
  | { kind: 'unconfirmed' };

/** Writes never throw: the caller must tell "rejected" from "may have landed". */
export type GitLabWriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: GitLabWriteFailure };

export interface GitLabDraftNotesHost {
  /** The token user's own draft notes on the MR, all pages. Throws a mapped AppError. */
  listOwnDraftNotes: (ref: HostRepoRef, iid: number) => Promise<GitLabDraftNote[]>;
  /** `position: null` ⇒ a general (unpositioned) note. Write policy: 429 only. */
  createDraftNote: (
    ref: HostRepoRef,
    iid: number,
    input: { note: string; position: GitLabDraftPosition | null },
    opts: { waitBudget: WaitBudget },
  ) => Promise<GitLabWriteResult<GitLabDraftNote>>;
  /** Idempotent; throws after the read/idempotent retries are exhausted. */
  deleteDraftNote: (
    ref: HostRepoRef,
    iid: number,
    draftId: number,
  ) => Promise<'deleted' | 'not_found'>;
  /** Publishes ALL of the token user's drafts, with an optional summary note. */
  bulkPublishDraftNotes: (
    ref: HostRepoRef,
    iid: number,
    input: { note: string | null },
    opts: { waitBudget: WaitBudget },
  ) => Promise<GitLabWriteResult<null>>;
  /** Every non-system note of every discussion (diff and general), all pages. */
  listMrNotes: (ref: HostRepoRef, iid: number) => Promise<GitLabMrNote[]>;
}
