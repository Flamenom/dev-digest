/* hooks/eval.ts — React Query hooks for L06 Eval Pipeline (screens A–F).
   One hook per route in `specs/06-eval-pipeline.md` §6 (R1–R17):

     R1  POST   /findings/:id/eval-case            → useCreateEvalCaseFromFinding
     R1b GET    /findings/:id/eval-case-draft      → useEvalCaseDraft
     R2  GET    /pulls/:id/eval-cases              → usePrEvalCases
     R3  GET    /agents/:id/eval-cases             → useAgentEvalCases
     R4  POST   /eval-cases                        → useCreateEvalCase
     R5  GET    /eval-cases/:id                    → useEvalCase
     R6  PUT    /eval-cases/:id                    → useUpdateEvalCase
     R7  DELETE /eval-cases/:id[?force=true]       → useDeleteEvalCase
     R8  POST   /eval-cases/:id/run                → useRunEvalCase
     R9  POST   /agents/:id/eval-runs              → useStartEvalBatch
     R10 GET    /evals/batches/:batchId            → useEvalBatch
     R11 GET    /agents/:id/eval-batches           → useAgentEvalBatches
     R12 GET    /agents/:id/eval-runs              → useAgentEvalRuns
     R13 GET    /agents/:id/eval-dashboard         → useAgentEvalDashboard
     R14 POST   /agents/:id/versions/:v/promote    → usePromoteAgentVersion
     R15 GET    /evals/dashboard                   → useEvalDashboard
     R16 GET    /evals/compare?base=&head=         → useEvalCompare
     R17 POST   /evals/run-all                     → useRunAllEvals

   Conventions carried from `client/CLAUDE.md`:
     - every request goes through `lib/api.ts`; this file never calls `fetch`.
     - IDs are row **uuids** (the PR *number* only ever appears in a route path,
       never here).
     - 4xx stays silent — the global handler toasts network/5xx only, and the
       eval screens render 409/422 as inline empty states. No hook adds its own
       error toast. */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  EvalAgentDashboard,
  EvalBatchRecord,
  EvalBatchStarted,
  EvalCaseDraft,
  EvalCaseFromFindingInput,
  EvalCaseInput,
  EvalCaseLink,
  EvalCaseRecord,
  EvalCaseRunRecord,
  EvalCompare,
  EvalDashboardOverview,
  EvalDraftRunInput,
  EvalPromoteResult,
  EvalRunAllResult,
  EvalRunResult,
} from "@devdigest/shared";

/** The `?days=` window the drill-down (screen C) filters everything by (§8.3). */
export type EvalWindowDays = number | "all";

/** Server default for `?days=`; mirrored here so the query key is never `undefined`. */
export const EVAL_WINDOW_DAYS_DEFAULT: EvalWindowDays = 30;

/** `?days=…` (omitted entirely when the caller passes nothing). */
function windowQuery(days: EvalWindowDays | null | undefined): string {
  if (days == null) return "";
  return `?${new URLSearchParams({ days: String(days) }).toString()}`;
}

/** Poll a batch every 2s while it is still running, then stop (§8.1, AC-22). */
const BATCH_POLL_MS = 2000;

/* ========================================================================= *
 * Screen A — the PR page's "which findings already have a case" join
 * ========================================================================= */

/**
 * R2 — every eval case created from a finding of this PR. `FindingCard` joins
 * it by `finding_id` client-side to render the "Eval case ✓" state, so the
 * frozen `ReviewRecord.findings` contract stays untouched (§7).
 */
export function usePrEvalCases(prId: string | null | undefined) {
  return useQuery({
    queryKey: ["pr-eval-cases", prId],
    queryFn: () => api.get<EvalCaseLink[]>(`/pulls/${prId}/eval-cases`),
    enabled: !!prId,
  });
}

/**
 * R1b — the composed-but-UNSAVED case a finding would produce (C24).
 *
 * The PR page opens the case editor on this, so clicking "Turn into eval case"
 * writes nothing: the button reaches its created state only once the user
 * saves. Same guards as R1, so a 409 here means a bare Save would 409 too.
 */
export function useEvalCaseDraft(findingId: string | null | undefined) {
  return useQuery({
    queryKey: ["eval-case-draft", findingId],
    queryFn: () => api.get<EvalCaseDraft>(`/findings/${findingId}/eval-case-draft`),
    enabled: !!findingId,
    // ALWAYS refetch when the editor mounts. The draft's expectation kind is
    // derived from the finding's judgement, so a cached one would still say
    // `must_find` after the reviewer flipped accept → dismiss and reopened the
    // modal. Refetching mid-session is harmless: the form seeds its state once
    // on mount, so a later response cannot overwrite what the user typed.
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    staleTime: 0,
    retry: false,
  });
}

export interface CreateEvalCaseFromFindingInput {
  findingId: string;
  /** The PR whose `["pr-eval-cases", prId]` cache must show the new link. */
  prId?: string;
  /**
   * The draft as the user approved it in the editor. Omit every field to let
   * the server persist what it composed. Provenance is not settable here —
   * `owner_id` and `source_finding_id` are always minted from the finding.
   */
  body?: EvalCaseFromFindingInput;
}

/**
 * R8b — run an UNSAVED case against an agent. Persists nothing: no `eval_runs`
 * row, so a draft run never moves a metric and never joins a batch. Same engine
 * call and same scoring as a saved run, so it predicts rather than approximates.
 */
export function useRunDraftEvalCase() {
  return useMutation({
    mutationFn: ({ agentId, body }: { agentId: string; body: EvalDraftRunInput }) =>
      api.post<EvalRunResult>(`/agents/${agentId}/eval-cases/run-draft`, body),
    // Deliberately no invalidation: nothing was written.
  });
}

/**
 * R1 — case creation from a judged finding. Idempotent server-side
 * (`eval_cases_source_finding_uq`): a re-click answers 200 with the existing
 * case. 409 `finding_not_judged` / `no_patch_for_file` / `finding_has_no_agent`
 * is rendered inline by the caller, never toasted.
 */
export function useCreateEvalCaseFromFinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ findingId, body }: CreateEvalCaseFromFindingInput) =>
      api.post<EvalCaseRecord>(`/findings/${findingId}/eval-case`, body),
    onSuccess: (data, { prId }) => {
      qc.setQueryData<EvalCaseRecord>(["eval-case", data.id], data);
      if (prId) qc.invalidateQueries({ queryKey: ["pr-eval-cases", prId] });
      // A new case changes the owning agent's case list and both dashboards'
      // `cases_total`.
      qc.invalidateQueries({ queryKey: ["agent-eval-cases", data.owner_id] });
      qc.invalidateQueries({ queryKey: ["eval-agent-dashboard", data.owner_id] });
      qc.invalidateQueries({ queryKey: ["eval-dashboard"] });
    },
  });
}

/* ========================================================================= *
 * Cases — screens E and F
 * ========================================================================= */

/** R3 — every eval case owned by one agent (Evals tab + case list). */
export function useAgentEvalCases(agentId: string | null | undefined) {
  return useQuery({
    queryKey: ["agent-eval-cases", agentId],
    queryFn: () => api.get<EvalCaseRecord[]>(`/agents/${agentId}/eval-cases`),
    enabled: !!agentId,
  });
}

/** R5 — one case, for the editor modal. */
export function useEvalCase(caseId: string | null | undefined) {
  return useQuery({
    queryKey: ["eval-case", caseId],
    queryFn: () => api.get<EvalCaseRecord>(`/eval-cases/${caseId}`),
    enabled: !!caseId,
  });
}

/** R4 — create a case from scratch (`+ New eval case`). */
export function useCreateEvalCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: EvalCaseInput) => api.post<EvalCaseRecord>("/eval-cases", input),
    onSuccess: (data) => {
      qc.setQueryData<EvalCaseRecord>(["eval-case", data.id], data);
      qc.invalidateQueries({ queryKey: ["agent-eval-cases", data.owner_id] });
      qc.invalidateQueries({ queryKey: ["eval-agent-dashboard", data.owner_id] });
      qc.invalidateQueries({ queryKey: ["eval-dashboard"] });
    },
  });
}

export interface UpdateEvalCaseInput {
  caseId: string;
  patch: Partial<EvalCaseInput>;
}

/** R6 — save the editor modal. */
export function useUpdateEvalCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, patch }: UpdateEvalCaseInput) =>
      api.put<EvalCaseRecord>(`/eval-cases/${caseId}`, patch),
    onSuccess: (data) => {
      qc.setQueryData<EvalCaseRecord>(["eval-case", data.id], data);
      qc.invalidateQueries({ queryKey: ["agent-eval-cases", data.owner_id] });
    },
  });
}

export interface DeleteEvalCaseInput {
  caseId: string;
  /** Owning agent — lets the delete invalidate only that agent's case list. */
  agentId?: string;
  /** `?force=true` — required by the server once the case has runs (409 otherwise). */
  force?: boolean;
}

/** R7 — delete a case; 409 `case_has_runs` unless `force`. */
export function useDeleteEvalCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, force }: DeleteEvalCaseInput) =>
      api.del<{ deleted: true }>(`/eval-cases/${caseId}${force ? "?force=true" : ""}`),
    onSuccess: (_data, { caseId, agentId }) => {
      qc.removeQueries({ queryKey: ["eval-case", caseId] });
      qc.invalidateQueries({ queryKey: ["agent-eval-cases", agentId] });
      qc.invalidateQueries({ queryKey: ["eval-agent-dashboard", agentId] });
      // The case may have been created from a finding — its "Eval case ✓" badge
      // must clear on whichever PR page holds it.
      qc.invalidateQueries({ queryKey: ["pr-eval-cases"] });
      qc.invalidateQueries({ queryKey: ["eval-dashboard"] });
    },
  });
}

export interface RunEvalCaseInput {
  caseId: string;
  /** Owning agent — scopes the post-run invalidation. */
  agentId?: string;
}

/** R8 — run one case synchronously (`▷ Run case`); 502 on a provider failure. */
export function useRunEvalCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId }: RunEvalCaseInput) =>
      api.post<EvalRunResult>(`/eval-cases/${caseId}/run`),
    onSuccess: (_data, { caseId, agentId }) => {
      // The run writes a new `last_run` strip onto the case and a new row into
      // the agent's run history.
      qc.invalidateQueries({ queryKey: ["eval-case", caseId] });
      qc.invalidateQueries({ queryKey: ["agent-eval-cases", agentId] });
      qc.invalidateQueries({ queryKey: ["agent-eval-runs", agentId] });
      qc.invalidateQueries({ queryKey: ["eval-agent-dashboard", agentId] });
      qc.invalidateQueries({ queryKey: ["eval-dashboard"] });
    },
  });
}

/* ========================================================================= *
 * Batches — screens B, C and E
 * ========================================================================= */

export interface StartEvalBatchInput {
  agentId: string;
  /** Omit to run every case of the agent (C11). */
  caseIds?: string[];
}

/**
 * R9 — start a batch (202 + `batch_id`). The response is only the handle; the
 * caller polls `useEvalBatch(batch_id)` for progress. 409
 * `batch_already_running` / 422 `no_cases` | `too_many_cases` stay inline.
 */
export function useStartEvalBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, caseIds }: StartEvalBatchInput) =>
      api.post<EvalBatchStarted>(
        `/agents/${agentId}/eval-runs`,
        caseIds ? { case_ids: caseIds } : undefined,
      ),
    onSuccess: (data) => {
      // Pending rows exist the moment the 202 lands — every list that shows a
      // batch (or its progress) must pick the new one up.
      qc.invalidateQueries({ queryKey: ["agent-eval-batches", data.agent_id] });
      qc.invalidateQueries({ queryKey: ["agent-eval-runs", data.agent_id] });
      qc.invalidateQueries({ queryKey: ["eval-agent-dashboard", data.agent_id] });
      qc.invalidateQueries({ queryKey: ["eval-dashboard"] });
    },
  });
}

/**
 * R10 — one batch, aggregated on read. Polls every 2s while `status ===
 * 'running'` and stops on its own once the batch finishes; a `running` batch
 * reports partial counts, so the UI shows progress instead of metrics (AC-22).
 */
export function useEvalBatch(batchId: string | null | undefined) {
  return useQuery({
    queryKey: ["eval-batch", batchId],
    queryFn: () => api.get<EvalBatchRecord>(`/evals/batches/${batchId}`),
    enabled: !!batchId,
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? BATCH_POLL_MS : false,
  });
}

/** R11 — the drill-down's `RECENT RUNS` table, filtered by the `?days=` window. */
export function useAgentEvalBatches(
  agentId: string | null | undefined,
  days: EvalWindowDays | null | undefined = EVAL_WINDOW_DAYS_DEFAULT,
) {
  return useQuery({
    queryKey: ["agent-eval-batches", agentId, days],
    queryFn: () => api.get<EvalBatchRecord[]>(`/agents/${agentId}/eval-batches${windowQuery(days)}`),
    enabled: !!agentId,
  });
}

export interface AgentEvalRunsOptions {
  /** Restrict to one batch — the Evals tab's per-case result flip. */
  batchId?: string;
  limit?: number;
  /** Poll every 2s while the batch this list belongs to is still running. */
  poll?: boolean;
}

/**
 * R12 — the per-case run rows behind a batch. Screen E flips each case row to
 * its result as the batch progresses, which is what `poll` is for; the caller
 * turns it off once `useEvalBatch` reports a terminal status.
 */
export function useAgentEvalRuns(
  agentId: string | null | undefined,
  { batchId, limit, poll = false }: AgentEvalRunsOptions = {},
) {
  const params = new URLSearchParams();
  if (batchId) params.set("batch_id", batchId);
  if (limit != null) params.set("limit", String(limit));
  const qs = params.toString();
  return useQuery({
    queryKey: ["agent-eval-runs", agentId, batchId ?? null, limit ?? null],
    queryFn: () =>
      api.get<EvalCaseRunRecord[]>(`/agents/${agentId}/eval-runs${qs ? `?${qs}` : ""}`),
    enabled: !!agentId,
    refetchInterval: poll ? BATCH_POLL_MS : false,
  });
}

/* ========================================================================= *
 * Dashboards — screens B and C
 * ========================================================================= */

/** R15 — `/evals`: every agent's row-card plus the all-agents batch table. */
export function useEvalDashboard() {
  return useQuery({
    queryKey: ["eval-dashboard"],
    queryFn: () => api.get<EvalDashboardOverview>("/evals/dashboard"),
  });
}

/**
 * R13 — `/evals/[agentId]`. The server filters the metric cards, the trend and
 * the batch table by the same window, so the page must NOT re-filter client-side
 * (§8.3) — the window belongs in the query key and in `?days=`, nowhere else.
 */
export function useAgentEvalDashboard(
  agentId: string | null | undefined,
  days: EvalWindowDays | null | undefined = EVAL_WINDOW_DAYS_DEFAULT,
) {
  return useQuery({
    queryKey: ["eval-agent-dashboard", agentId, days],
    queryFn: () =>
      api.get<EvalAgentDashboard>(`/agents/${agentId}/eval-dashboard${windowQuery(days)}`),
    enabled: !!agentId,
  });
}

/* ========================================================================= *
 * Compare + promote — screen D
 * ========================================================================= */

/**
 * R16 — compare two batches of the SAME agent. Disabled until two distinct
 * batches are selected; the server still answers 422 `same_batch` /
 * `cross_agent_compare`, which the modal renders inline.
 */
export function useEvalCompare(
  base: string | null | undefined,
  head: string | null | undefined,
) {
  return useQuery({
    queryKey: ["eval-compare", base, head],
    queryFn: () => {
      // `enabled` guarantees both are set by the time this runs.
      const params = new URLSearchParams({ base: base ?? "", head: head ?? "" });
      return api.get<EvalCompare>(`/evals/compare?${params.toString()}`);
    },
    enabled: !!base && !!head && base !== head,
  });
}

export interface PromoteAgentVersionInput {
  agentId: string;
  version: number;
}

/**
 * R14 — promote a historical version's config. Version history is append-only:
 * promoting v7 while the agent is at v9 creates v10 (§9.2), and `changed:
 * false` means the target already equals the live config. Promoting never
 * re-runs evals, so no batch/metric key is touched here (AC-31).
 */
export function usePromoteAgentVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, version }: PromoteAgentVersionInput) =>
      api.post<EvalPromoteResult>(`/agents/${agentId}/versions/${version}/promote`),
    onSuccess: (data) => {
      qc.setQueryData(["agent", data.agent.id], data.agent);
      qc.invalidateQueries({ queryKey: ["agents"] });
      // The version number is shown on the agent card / drill-down header.
      qc.invalidateQueries({ queryKey: ["eval-agent-dashboard", data.agent.id] });
      qc.invalidateQueries({ queryKey: ["eval-dashboard"] });
    },
  });
}

/* ========================================================================= *
 * Run all — screen B
 * ========================================================================= */

/**
 * R17 — one batch per eligible agent (202). `skipped` explains every agent that
 * did not start (`no_cases` / `already_running` / `disabled`) and is rendered
 * by the caller.
 */
export function useRunAllEvals() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<EvalRunAllResult>("/evals/run-all"),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["eval-dashboard"] });
      for (const started of data.started) {
        qc.invalidateQueries({ queryKey: ["agent-eval-batches", started.agent_id] });
        qc.invalidateQueries({ queryKey: ["agent-eval-runs", started.agent_id] });
        qc.invalidateQueries({ queryKey: ["eval-agent-dashboard", started.agent_id] });
      }
    },
  });
}
