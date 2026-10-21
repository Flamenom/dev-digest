/**
 * Publish codes → fixed user messages and synchronous HTTP statuses (spec
 * `specs/2026-10-21-gitlab-publish-findings.md`, "Contracts"; plan T5, Q4/Q5).
 * Pure. Messages are fixed server strings: they never carry a note body, the
 * summary, a token or upstream response detail.
 */
import type {
  GitLabWriteFailure,
  PublishBlockerCode,
  PublishErrorCode,
} from '@devdigest/shared';
import { AppError } from '../../platform/errors.js';

/** AC-4 — exact spec text. */
export const REVIEW_HEAD_UNKNOWN_MESSAGE =
  'This review predates publish support — re-run the review to publish its findings.';

/** AC-5 / AC-12 — exact spec text. */
export const REVIEW_DIFF_OUTDATED_MESSAGE =
  'New commits were pushed since this review — re-run the review to publish.';

/** AC-33 — exact spec text. */
export const PUBLISH_UNCONFIRMED_MESSAGE =
  "GitLab didn't confirm the publish — check the MR before publishing again.";

/** AC-31 — says the drafts remain on the service account and self-heal (AC-23). */
export const DRAFTS_LEFT_BEHIND_MESSAGE =
  'Publishing failed and some DevDigest draft notes remain on the service account. The next publish to this merge request removes them.';

/**
 * Same text as `GITLAB_INSUFFICIENT_SCOPE_MESSAGE` (settings/gitlab-token-health.ts),
 * duplicated to avoid a cross-module import; a test pins the equality.
 */
export const TOKEN_INSUFFICIENT_SCOPE_MESSAGE =
  'This token is missing the api scope. Required scope: api (Reporter role recommended).';

/** Same text as `GITLAB_INVALID_TOKEN_MESSAGE` (settings/gitlab-token-health.ts); test-pinned. */
export const TOKEN_INVALID_MESSAGE =
  'GitLab rejected the token (invalid, expired or revoked). Update it in Settings → API keys.';

/** Same text as `GITLAB_UNVERIFIED_MESSAGE` (settings/gitlab-token-health.ts); test-pinned. */
export const TOKEN_UNVERIFIED_MESSAGE = "Couldn't verify the token's scopes — try again";

/** One fixed message per code (blockers, request errors, publication / item codes). */
export const PUBLISH_MESSAGES: Readonly<Record<PublishErrorCode, string>> = {
  publish_selection_invalid: 'Select between 1 and 50 distinct findings of this review.',
  publish_summary_invalid:
    'The summary must be at most 10,000 characters and not only whitespace.',
  finding_not_publishable: 'One or more selected findings cannot be published.',
  finding_already_published: 'One or more selected findings are already published.',
  publish_in_progress: 'A publish to this merge request is already in progress.',
  provider_not_supported: 'Publishing findings is supported for GitLab merge requests only.',
  review_head_unknown: REVIEW_HEAD_UNKNOWN_MESSAGE,
  review_diff_outdated: REVIEW_DIFF_OUTDATED_MESSAGE,
  pr_not_open: 'This merge request is not open, so findings cannot be published to it.',
  gitlab_drafts_left_behind: DRAFTS_LEFT_BEHIND_MESSAGE,
  gitlab_position_rejected: 'GitLab rejected the position of this note.',
  gitlab_rate_limited:
    'GitLab rate-limited the publish. Nothing was published — try again in a minute.',
  gitlab_publish_failed: 'GitLab failed to publish the review. Nothing was published.',
  gitlab_publish_unconfirmed: PUBLISH_UNCONFIRMED_MESSAGE,
  gitlab_token_missing: 'Connect a GitLab token in Settings → API keys to publish findings.',
  gitlab_token_invalid: TOKEN_INVALID_MESSAGE,
  gitlab_token_insufficient_scope: TOKEN_INSUFFICIENT_SCOPE_MESSAGE,
  gitlab_token_unverified: TOKEN_UNVERIFIED_MESSAGE,
  gitlab_project_inaccessible: 'GitLab project not found or token has no access.',
};

/** The message of a review-level blocker (AC-3 – AC-8). */
export function blockerMessage(code: PublishBlockerCode): string {
  return PUBLISH_MESSAGES[code];
}

/**
 * HTTP status when a code is answered synchronously (spec "Contracts" table;
 * reused token/project codes keep their existing statuses). Codes that only
 * ever appear on a publication / item (`gitlab_drafts_left_behind`, …) map to
 * the status the route would use if one ever surfaced synchronously.
 */
export const PUBLISH_HTTP_STATUS: Readonly<Record<PublishErrorCode, number>> = {
  publish_selection_invalid: 400,
  publish_summary_invalid: 400,
  finding_not_publishable: 400,
  finding_already_published: 409,
  publish_in_progress: 409,
  provider_not_supported: 400,
  review_head_unknown: 409,
  review_diff_outdated: 409,
  pr_not_open: 409,
  gitlab_drafts_left_behind: 502,
  gitlab_position_rejected: 502,
  gitlab_rate_limited: 429,
  gitlab_publish_failed: 502,
  gitlab_publish_unconfirmed: 502,
  gitlab_token_missing: 400,
  gitlab_token_invalid: 400,
  gitlab_token_insufficient_scope: 400,
  gitlab_token_unverified: 503,
  gitlab_project_inaccessible: 404,
};

/** The synchronous `AppError` for a code, with its fixed message and status. */
export function publishError(code: PublishErrorCode, details?: unknown): AppError {
  return new AppError(code, PUBLISH_MESSAGES[code], PUBLISH_HTTP_STATUS[code], details);
}

/**
 * A failed GitLab write → the publication / item code (plan Q4, Q5):
 * 400/422 → `gitlab_position_rejected` (item; publication too when all fail);
 * 429 budget out → `gitlab_rate_limited`; 401 → `gitlab_token_invalid`;
 * 403 insufficient_scope → `gitlab_token_insufficient_scope`; other 403 →
 * `gitlab_publish_failed`; 404 → `gitlab_project_inaccessible`;
 * 5xx / timeout / network → `gitlab_publish_failed`.
 */
export function failureToPublicationCode(failure: GitLabWriteFailure): PublishErrorCode {
  switch (failure.kind) {
    case 'rejected':
      return 'gitlab_position_rejected';
    case 'rate_limited':
      return 'gitlab_rate_limited';
    case 'token_invalid':
      return 'gitlab_token_invalid';
    case 'insufficient_scope':
      return 'gitlab_token_insufficient_scope';
    case 'forbidden':
      return 'gitlab_publish_failed';
    case 'not_found':
      return 'gitlab_project_inaccessible';
    case 'unconfirmed':
      return 'gitlab_publish_failed';
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}
