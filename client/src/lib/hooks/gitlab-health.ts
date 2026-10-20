/* hooks/gitlab-health.ts — the stored GitLab token's health, derived from
   GET /settings/secrets-status (spec 2026-10-20-gitlab-comments, AC-25). */
"use client";

import { useSecretsStatus } from "./core";
import type { GitLabTokenHealth } from "../types";

/** Health values that block every GitLab operation in the UI (token notice + disabled post). */
const BLOCKING_HEALTH: ReadonlySet<GitLabTokenHealth> = new Set<GitLabTokenHealth>([
  "insufficient_scope",
  "invalid",
]);

export interface GitLabTokenHealthState {
  /** null ⇒ no GitLab token configured (or status not loaded yet) — treated like `unchecked`. */
  health: GitLabTokenHealth | null;
  /** true when the token is known bad (`insufficient_scope` / `invalid`). */
  blocked: boolean;
}

export function useGitLabTokenHealth(): GitLabTokenHealthState {
  const { data } = useSecretsStatus();
  const health = data?.gitlab_health ?? null;
  return { health, blocked: health !== null && BLOCKING_HEALTH.has(health) };
}
