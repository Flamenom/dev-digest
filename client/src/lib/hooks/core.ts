/* hooks/core.ts — typed React Query hooks over the F1 API (contracts):
   settings, secrets, repos, pulls, and project context. Scaffolding screens use
   these; feature-domain hooks live in the sibling files (agents/reviews/trace/…)
   and are re-exported alongside these from hooks/index.ts. */
"use client";

import { useQuery, useMutation, useQueryClient, queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import { errorChannelMeta } from "../query-meta";
import type { SecretsStatusDetailed } from "@devdigest/shared";
import type {
  Settings,
  SettingsUpdate,
  ConnTestProviderHost,
  ConnTestResultHost,
  RepoWithHost,
  PrListPage,
  PrDetailHost,
  PrSyncStartResult,
  SpecFile,
  IndexStatus,
} from "../types";

// ---- Settings (F1: GET/PUT /settings, POST /settings/test-connection) ----
export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<Settings>("/settings"),
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsUpdate) => api.put<Settings>("/settings", patch),
    onSuccess: (data) => qc.setQueryData(["settings"], data),
  });
}

export function useTestConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      input: ConnTestProviderHost | { provider: ConnTestProviderHost; key?: string },
    ) => {
      const body = typeof input === "string" ? { provider: input } : input;
      return api.post<ConnTestResultHost>("/settings/test-connection", body);
    },
    // The key row shows the result (or the failure) inline under its input.
    ...errorChannelMeta("local"),
    // Saving/validating a provider key can change which models resolve — drop the
    // cached (possibly empty) model lists so the agent picker refetches, and
    // refresh the "Configured / Not set" key-status badges.
    onSuccess: (res) => {
      if (res.ok) {
        qc.invalidateQueries({ queryKey: ["provider-models"] });
        qc.invalidateQueries({ queryKey: ["secrets-status"] });
      }
    },
  });
}

/**
 * Which provider keys are configured — never the values. The booleans are true
 * only for state `set`; `states` adds the per-key `set|unset|undecryptable`
 * state with `updated_at` / `updated_by` (multi-user server mode, AC-38).
 */
export function useSecretsStatus() {
  return useQuery({
    queryKey: ["secrets-status"],
    queryFn: () => api.get<SecretsStatusDetailed>("/settings/secrets-status"),
    staleTime: 30_000,
  });
}

// ---- Repos (F1: GET/POST /repos, refresh, delete) ----
export function useRepos() {
  return useQuery({
    queryKey: ["repos"],
    queryFn: () => api.get<RepoWithHost[]>("/repos"),
  });
}

export function useAddRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (url: string) => api.post<RepoWithHost>("/repos", { url }),
    // AddRepoView shows the failure inline under the URL field.
    ...errorChannelMeta("local"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["repos"] }),
  });
}

export function useRefreshRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repoId: string) => api.post<RepoWithHost>(`/repos/${repoId}/refresh`),
    onSuccess: (_d, repoId) => {
      qc.invalidateQueries({ queryKey: ["repos"] });
      qc.invalidateQueries({ queryKey: ["pulls", repoId] });
    },
  });
}

export function useDeleteRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repoId: string) => api.del<{ deleted: string }>(`/repos/${repoId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["repos"] }),
  });
}

// ---- Pull requests (GET /repos/:id/pulls/page, POST /repos/:id/pulls/sync, GET /pulls/:id) ----
/**
 * ONE cache entry per repo (`["pulls", repoId]`) holding the `{ pulls, sync }`
 * page. `usePullsPage` and `usePulls` share it (same key + same queryFn), so the
 * detail page's number→uuid lookup keeps reading the list the PR page loaded.
 *
 * No periodic refetch (AC-63): the list re-fetches only on open, on manual
 * refresh, or ONCE when a sync it started/joined completes (`usePrSyncCompletion`).
 * Hence no `refetchInterval` and no refetch on window focus.
 */
function pullsPageQuery(repoId: string | null | undefined) {
  return queryOptions({
    queryKey: ["pulls", repoId],
    queryFn: () => api.get<PrListPage>(`/repos/${repoId}/pulls/page`),
    enabled: !!repoId,
    refetchOnWindowFocus: false,
  });
}

/** The PR list plus its sync status (trigger/state/last-synced time). */
export function usePullsPage(repoId: string | null | undefined) {
  return useQuery(pullsPageQuery(repoId));
}

/** Just the PR rows of the shared `["pulls", repoId]` page. */
export function usePulls(repoId: string | null | undefined) {
  return useQuery({ ...pullsPageQuery(repoId), select: (page) => page.pulls });
}

/**
 * Manual PR-list sync: starts one, or joins the running one (`trigger`). The
 * list update arrives via `usePrSyncCompletion`, not by invalidating here.
 */
export function useSyncPulls() {
  return useMutation({
    mutationFn: (repoId: string) =>
      api.post<PrSyncStartResult>(`/repos/${repoId}/pulls/sync`),
  });
}

export function usePullDetail(prId: string | number | null | undefined) {
  return useQuery({
    queryKey: ["pull", prId],
    queryFn: () => api.get<PrDetailHost>(`/pulls/${prId}`),
    enabled: prId != null,
  });
}

// ---- Project Context (A3 contract; safe to call once API exposes it) ----
export function useContextFiles(repoId: string | null | undefined) {
  return useQuery({
    queryKey: ["context", repoId],
    queryFn: () => api.get<SpecFile[]>(`/repos/${repoId}/context`),
    enabled: !!repoId,
  });
}

export function useReindexContext() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repoId: string) => api.post<IndexStatus>(`/repos/${repoId}/context/reindex`),
    onSuccess: (_d, repoId) => qc.invalidateQueries({ queryKey: ["context", repoId] }),
  });
}
