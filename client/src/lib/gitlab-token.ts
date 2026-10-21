/* gitlab-token.ts — pure constants for the stored GitLab token's health
   (spec 2026-10-20-gitlab-comments, AC-21, AC-25). No React, no I/O: shared by
   the token-health hook, the comment mutation and the Settings → API Keys row. */
import type { HostCommentErrorCode, HostErrorCode } from "@devdigest/shared";
import type { GitLabTokenHealth } from "./types";

/** Health values that block every GitLab operation in the UI (token notice + disabled post). */
export type BlockingGitLabHealth = Extract<GitLabTokenHealth, "insufficient_scope" | "invalid">;

/** API error codes meaning the stored GitLab token is unusable (AC-21, AC-25). */
export const GITLAB_TOKEN_ERROR_CODE = {
  invalid: "gitlab_token_invalid",
  insufficientScope: "gitlab_token_insufficient_scope",
} as const satisfies Record<string, HostErrorCode | HostCommentErrorCode>;

/** An API error code meaning the stored GitLab token's health just changed. */
export type GitLabTokenHealthErrorCode =
  (typeof GITLAB_TOKEN_ERROR_CODE)[keyof typeof GITLAB_TOKEN_ERROR_CODE];

/** Error codes meaning the stored GitLab token's health just changed — refresh secrets-status. */
export const GITLAB_TOKEN_HEALTH_ERROR_CODES: ReadonlySet<HostErrorCode | HostCommentErrorCode> =
  new Set<HostErrorCode | HostCommentErrorCode>(Object.values(GITLAB_TOKEN_ERROR_CODE));

/** Narrows an untyped wire error code (`ApiError.code`) to a token-health code. */
export function isGitLabTokenHealthErrorCode(code: string | undefined): code is GitLabTokenHealthErrorCode {
  return code != null && (GITLAB_TOKEN_HEALTH_ERROR_CODES as ReadonlySet<string>).has(code);
}
