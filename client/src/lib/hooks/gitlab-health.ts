/* hooks/gitlab-health.ts — the stored GitLab token's health, derived from
   GET /settings/secrets-status (spec 2026-10-20-gitlab-comments, AC-25), and
   the ONE rule for "this repo's GitLab operations are blocked by the token". */
"use client";

import { useSecretsStatus } from "./core";
import type { BlockingGitLabHealth } from "../gitlab-token";
import type { GitLabTokenHealth, RepoWithHost } from "../types";

const BLOCKING_HEALTH: ReadonlySet<GitLabTokenHealth> = new Set<BlockingGitLabHealth>([
  "insufficient_scope",
  "invalid",
]);

function isBlockingHealth(health: GitLabTokenHealth | null | undefined): health is BlockingGitLabHealth {
  return health != null && BLOCKING_HEALTH.has(health);
}

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
