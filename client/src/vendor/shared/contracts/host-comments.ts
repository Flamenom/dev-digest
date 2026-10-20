import { z } from 'zod';
import { PrCommentInput, PrReviewComment } from './platform.js';
import { ConnTestResultHost, RepoProvider } from './repo-host.js';
import { SecretsStatusDetailed } from './secrets-status.js';

/**
 * Host comments — GitLab phase 2: posting inline comments and replies
 * (spec `specs/2026-10-20-gitlab-comments.md`).
 *
 * ADDITIVE contract — no pre-existing contract file is edited. Every schema here
 * EXTENDS an existing one (`PrReviewComment`, `PrCommentInput`,
 * `SecretsStatusDetailed`, `ConnTestResultHost`), so an old-shape object still
 * parses with the new schema. New optional fields use `.optional()` /
 * `.nullish()` (never a bare `.nullable()`), so no existing fixture has to grow
 * a key.
 */

// ---- Comments (read shape) ----
/**
 * A PR/MR inline comment from either host. A GitHub comment parses unchanged
 * (AC-34). GitLab notes add the discussion they belong to and, for notes the
 * service account posted with the DevDigest footer, the attributed user (AC-7).
 */
export const HostComment = PrReviewComment.extend({
  /** GitLab discussion id (thread); null/absent on GitHub. */
  discussion_id: z.string().nullish(),
  provider: RepoProvider.optional(),
  /** Present when the note was posted via DevDigest on behalf of a user (footer stripped). */
  devdigest_attribution: z.object({ name: z.string() }).nullish(),
});
export type HostComment = z.infer<typeof HostComment>;

// ---- Comments (write shape) ----
/**
 * Body for POST /pulls/:id/comments on either host. A blank body is rejected
 * (AC-14). A GitHub reply sets `in_reply_to` (comment id); a GitLab reply sets
 * `discussion_id` — never both.
 *
 * The `.refine` is the outermost step on purpose: do not `.extend` this schema
 * (a refined schema is a ZodEffects and has no `.extend`).
 */
export const HostCommentInput = PrCommentInput.extend({
  body: z.string().refine((s) => s.trim().length > 0, 'Comment body must not be empty'),
  /** Reply to an existing GitLab discussion (its discussion id). */
  discussion_id: z.string().min(1).optional(),
}).refine((v) => !(v.in_reply_to != null && v.discussion_id != null), {
  message: 'Set at most one of in_reply_to / discussion_id',
  path: ['discussion_id'],
});
export type HostCommentInput = z.infer<typeof HostCommentInput>;

/** GitLab's note body limit, applied to the exact text sent (body + footer, AC-15). */
export const GITLAB_COMMENT_MAX_CHARS = 1_000_000;

// ---- GitLab token health ----
/**
 * Health of the stored GitLab token (AC-24 – AC-26). `unchecked` ⇒ not verified
 * yet (or the check was transiently impossible).
 */
export const GitLabTokenHealth = z.enum(['ok', 'insufficient_scope', 'invalid', 'unchecked']);
export type GitLabTokenHealth = z.infer<typeof GitLabTokenHealth>;

/** GET /settings/secrets-status plus the GitLab token health (null ⇒ no GitLab token). */
export const SecretsStatusWithHealth = SecretsStatusDetailed.extend({
  gitlab_health: GitLabTokenHealth.nullish(),
});
export type SecretsStatusWithHealth = z.infer<typeof SecretsStatusWithHealth>;

/** Connection test / save result with a machine-readable failure code (AC-21, AC-28). */
export const ConnTestResultWithCode = ConnTestResultHost.extend({
  code: z.string().optional(),
});
export type ConnTestResultWithCode = z.infer<typeof ConnTestResultWithCode>;

// ---- Error codes ----
/** Error codes introduced by host comment posting (in addition to `HostErrorCode`). */
export const HostCommentErrorCode = z.enum([
  'comment_position_invalid',
  'comment_diff_outdated',
  'comment_thread_not_found',
  'comment_too_long',
  'gitlab_token_insufficient_scope',
  'gitlab_token_unverified',
  'gitlab_comment_failed',
]);
export type HostCommentErrorCode = z.infer<typeof HostCommentErrorCode>;

// ---- Audit ----
/**
 * Metadata of the `pr_comment.create` audit event (AC-42). Strict: the comment
 * body (or any other key) must never be recorded.
 */
export const PrCommentAuditMetadata = z
  .object({
    provider: RepoProvider,
    host_comment_id: z.number().int(),
    discussion_id: z.string().optional(),
    is_reply: z.boolean(),
  })
  .strict();
export type PrCommentAuditMetadata = z.infer<typeof PrCommentAuditMetadata>;
