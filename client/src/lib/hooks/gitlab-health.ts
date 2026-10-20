/* hooks/gitlab-health.ts — the stored GitLab token's health, derived from
   GET /settings/secrets-status (spec 2026-10-20-gitlab-comments, AC-25), and
   the ONE rule for "this repo's GitLab operations are blocked by the token". */
"use client";

import { useSecretsStatus } from "./core";
import type { HostCommentErrorCode, HostErrorCode } from "@devdigest/shared";
import type { GitLabTokenHealth, RepoWithHost } from "../types";

/** Health values that block every GitLab operation in the UI (token notice + disabled post). */
export type BlockingGitLabHealth = Extract<GitLabTokenHealth, "insufficient_scope" | "invalid">;

const BLOCKING_HEALTH: ReadonlySet<GitLabTokenHealth> = new Set<BlockingGitLabHealth>([
  "insufficient_scope",
  "invalid",
]);

function isBlockingHealth(health: GitLabTokenHealth | null | undefined): health is BlockingGitLabHealth {
  return health != null && BLOCKING_HEALTH.has(health);
}

/** API error codes meaning the stored GitLab token is unusable (AC-21, AC-25). */
export const GITLAB_TOKEN_ERROR_CODE = {
  invalid: "gitlab_token_invalid",
  insufficientScope: "gitlab_token_insufficient_scope",
} as const satisfies Record<string, HostErrorCode | HostCommentErrorCode>;

/** Error codes meaning the stored GitLab token's health just changed — refresh secrets-status. */
export const GITLAB_TOKEN_HEALTH_ERROR_CODES: ReadonlySet<string> = new Set<string>(
  Object.values(GITLAB_TOKEN_ERROR_CODE),
);

/**
 * The blocking token health for `repo`, or null when nothing is blocked: the
 * repo is not on GitLab, no GitLab token is configured / status not loaded yet
 * (treated like `unchecked`), or the token is `ok` / `unchecked`.
 */
export function useGitLabTokenHealth(
  repo: Pick<RepoWithHost, "provider"> | null | undefined,
): BlockingGitLabHealth | null {
  const { data } = useSecretsStatus();
  const health = data?.gitlab_health;
  return repo?.provider === "gitlab" && isBlockingHealth(health) ? health : null;
}
