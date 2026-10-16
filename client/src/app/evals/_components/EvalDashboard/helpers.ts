/* Pure helpers for the /evals overview. No React, no I/O — unit-testable on
   their own (frontend-ui-architecture §5: utils stay pure). */

import type { EvalBatchRecord } from "@devdigest/shared";
import { EMPTY_METRIC } from "./constants";

/**
 * A micro-averaged metric as a percentage. `null` means the denominator was
 * zero (§4.6) and MUST render as `—`, never as a score (AC-21).
 */
export function formatMetric(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return EMPTY_METRIC;
  return `${Math.round(value * 100)}%`;
}

/** Batch cost, or `—` when the provider reported no usage (AC-49). */
export function formatCost(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return EMPTY_METRIC;
  return `$${value.toFixed(3)}`;
}

/** Compact "2m ago" stamp for a batch's `ran_at`. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const sec = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export interface BatchProgress {
  done: number;
  total: number;
  /** 0–100, clamped; 0 when the batch has no cases at all. */
  pct: number;
}

/**
 * How far a batch has got. A `running` batch reports partial counts (§8.1), so
 * this is what the UI shows in place of its metric values (AC-22).
 */
export function batchProgress(batch: EvalBatchRecord): BatchProgress {
  const done = batch.cases_passed + batch.cases_failed + batch.cases_errored;
  const total = batch.cases_total;
  const pct = total > 0 ? Math.round((Math.min(done, total) / total) * 100) : 0;
  return { done, total, pct };
}

/** `true` while the batch is still executing — the AC-22 switch. */
export function isRunning(batch: EvalBatchRecord | null | undefined): boolean {
  return batch?.status === "running";
}
