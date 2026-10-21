/* constants.ts — fixed values shared by the publish-findings UI (spec
   2026-10-21-gitlab-publish-findings, AC-36 – AC-39). */
import type { PublishBlockerCode, PublishErrorCode, Severity } from "@devdigest/shared";
import type { BlockingGitLabHealth } from "@/lib/gitlab-token";

/** Blockers whose notice offers "Re-run review" (AC-37). */
export const RERUN_BLOCKERS: ReadonlySet<PublishBlockerCode> = new Set<PublishBlockerCode>([
  "review_head_unknown",
  "review_diff_outdated",
]);

/** Publish error codes whose remedy is re-running the review (AC-12). */
export const RERUN_ERROR_CODES: ReadonlySet<string> = new Set<PublishErrorCode>([
  "review_head_unknown",
  "review_diff_outdated",
]);

/** Token blockers rendered by the comments-spec token notice (AC-37). */
export const TOKEN_NOTICE_HEALTH: Partial<Record<PublishBlockerCode, BlockingGitLabHealth>> = {
  gitlab_token_insufficient_scope: "insufficient_scope",
  gitlab_token_invalid: "invalid",
};

/** The missing-token blocker: same Admin-link / Member-text affordance, server message. */
export const TOKEN_MISSING_BLOCKER: PublishBlockerCode = "gitlab_token_missing";

/** Severity order of the dialog's counts (matches the publish order, AC-25). */
export const SEVERITY_ORDER: readonly Severity[] = ["CRITICAL", "WARNING", "SUGGESTION"];
