/* helpers.ts — pure derivations for the AgentEditor `Evals` tab (spec §10 E).
   No React and no I/O, so the tab and its test can exercise them directly. */

import type {
  EvalBatchRecord,
  EvalCaseRecord,
  EvalCaseRunRecord,
} from "@devdigest/shared";
import { EM_DASH, MIN_TREND_POINTS } from "./constants";

/** `0.78` → `"78%"`. A null metric renders the em dash, never a vacuous 0%. */
export function formatPercent(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return EM_DASH;
  return `${Math.round(v * 100)}%`;
}

/** `0.0123` → `"$0.0123"`. Batch cost is summed in USD and is often sub-cent. */
export function formatCost(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return EM_DASH;
  return `$${v.toFixed(4)}`;
}

/**
 * Deterministic UTC stamp. A locale-dependent string would make the rendered
 * sub-line depend on the machine running the test.
 */
export function formatRanAt(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The batch the metric cards read: the newest **complete** one (§8.2 — a
 * rolling average would mix agent versions and case-set revisions, which is not
 * the question "did the change I just made help"). Selected by `ran_at` rather
 * than by list position so it does not depend on the server's ordering.
 */
export function latestCompleteBatch(
  batches: readonly EvalBatchRecord[] | undefined,
): EvalBatchRecord | null {
  let best: EvalBatchRecord | null = null;
  for (const b of batches ?? []) {
    if (b.status !== "complete") continue;
    if (!best || Date.parse(b.ran_at) > Date.parse(best.ran_at)) best = b;
  }
  return best;
}

/** A metric's sparkline, or `undefined` when there is not enough of a trend. */
export function trendOf(
  points: readonly { recall: number; precision: number; citation_accuracy: number }[] | undefined,
  key: "recall" | "precision" | "citation_accuracy",
): number[] | undefined {
  const data = (points ?? []).map((p) => p[key]);
  return data.length >= MIN_TREND_POINTS ? data : undefined;
}

/** One case row's outcome, unified across the persisted `last_run` (C5) and a
    live `eval_runs` row of the batch currently executing (C8). */
export interface CaseResult {
  /** `null` = errored (or, while `pending`, not yet decided) — never a fail (§4.4). */
  pass: boolean | null;
  expectedCount: number;
  /** `null` when the produced-finding count is not recoverable from the row. */
  producedCount: number | null;
  /** Per-case recall; only a live run row carries it. */
  recall: number | null;
  /** Server error code (`empty_diff`, …) when the case errored. */
  error: string | null;
  /** The batch has inserted the row but the case has not finished yet. */
  pending: boolean;
  /** The result came from the batch currently running, not from `last_run`. */
  live: boolean;
}

/** A pending row is the one written up front by `startBatch`: no output yet
    (§5.3). This is the ONLY way to tell "still running" from "errored", since
    both carry `pass = null`. */
export function isPendingRun(run: EvalCaseRunRecord): boolean {
  return run.actual_output == null;
}

/** `actual_output.findings.length`, read by shape — the frozen `EvalRunRecord`
    types the blob `z.unknown()`, so it is never assumed to be C7. */
export function producedCountOf(actual: unknown): number | null {
  if (typeof actual !== "object" || actual === null) return null;
  const findings = (actual as { findings?: unknown }).findings;
  return Array.isArray(findings) ? findings.length : null;
}

/** Index a batch's run rows by case, so a row can flip to its own result. */
export function runsByCase(
  runs: readonly EvalCaseRunRecord[] | undefined,
): Map<string, EvalCaseRunRecord> {
  const map = new Map<string, EvalCaseRunRecord>();
  for (const run of runs ?? []) map.set(run.case_id, run);
  return map;
}

/**
 * What one row shows: the live batch row when the case is part of the batch in
 * flight, otherwise the persisted `last_run` strip, otherwise "never run".
 */
export function resultForCase(
  record: EvalCaseRecord,
  live: EvalCaseRunRecord | undefined,
): CaseResult | null {
  const expectedCount = record.expected_output?.expectations?.length ?? 0;
  if (live) {
    if (isPendingRun(live)) {
      return { pass: null, expectedCount, producedCount: null, recall: null, error: null, pending: true, live: true };
    }
    return {
      pass: live.pass,
      expectedCount,
      producedCount: producedCountOf(live.actual_output),
      recall: live.recall,
      error: live.error ?? null,
      pending: false,
      live: true,
    };
  }
  const last = record.last_run;
  if (!last) return null;
  return {
    pass: last.pass,
    expectedCount: last.expected_count,
    producedCount: last.produced_count,
    recall: null,
    error: null,
    pending: false,
    live: false,
  };
}

/** Status bucket driving the row glyph, its label and its colour. */
export type CaseStatus = "pass" | "fail" | "errored" | "pending" | "never";

export function statusOf(result: CaseResult | null): CaseStatus {
  if (!result) return "never";
  if (result.pending) return "pending";
  if (result.pass === true) return "pass";
  if (result.pass === false) return "fail";
  return "errored";
}

/** `N / M passing` for the heading pill — M is every case, N the ones whose
    current result passed (a pending or errored case is not a pass). */
export function passingCounts(results: readonly (CaseResult | null)[]): {
  passed: number;
  total: number;
} {
  return {
    passed: results.filter((r) => r?.pass === true).length,
    total: results.length,
  };
}

/** How far a running batch has got: finished rows over inserted rows (§19.6). */
export function batchProgress(runs: readonly EvalCaseRunRecord[] | undefined): {
  finished: number;
  total: number;
} {
  const rows = runs ?? [];
  return { finished: rows.filter((r) => !isPendingRun(r)).length, total: rows.length };
}

/**
 * Read an `ApiError.code` off an unknown rejection **by shape**. 4xx stays
 * silent globally (client/CLAUDE.md), so the tab renders 409/422 inline.
 */
export function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** AC-12 — the affected run count out of a 409 `case_has_runs`, so the delete
    confirmation can state the consequence. `null` for any other rejection. */
export function readCaseHasRunsCount(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const err = error as { status?: unknown; code?: unknown; details?: unknown };
  if (err.status !== 409 || err.code !== "case_has_runs") return null;
  const details = err.details;
  if (typeof details !== "object" || details === null) return null;
  const count = (details as { run_count?: unknown }).run_count;
  return typeof count === "number" ? count : 0;
}
