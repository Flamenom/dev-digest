/* helpers.ts — pure display + selection logic for screen C.
   No React, no I/O: the component stays a thin renderer and every rule below is
   directly testable (`specs/06-eval-pipeline.md` §8.3, §8.4, §9.1). */

import type {
  EvalAlertSignal,
  EvalBatchRecord,
  EvalTrendPoint,
} from "@devdigest/shared";
import type { EvalWindowDays } from "@/lib/hooks/eval";
import { MAX_COMPARE_SELECTION, type TrendMetric } from "./constants";

/** Rendered wherever a metric is `null` — never a vacuous `0%` (AC-21). */
export const EM_DASH = "—";

/** Direction of a metric change. Drives the glyph AND the colour, so colour is
    never the only carrier of the meaning (AC-44, §14). */
export type DeltaTone = "up" | "down" | "flat" | "none";

const GLYPH: Record<DeltaTone, string> = {
  up: "▲",
  down: "▼",
  flat: "=",
  none: "",
};

export interface DeltaDisplay {
  /** Glyph + magnitude + unit, e.g. `"▲4pt"` — text, not colour (AC-44). */
  text: string;
  tone: DeltaTone;
}

/* ------------------------------------------------------------ formatting -- */

/** `0.78` → `"78%"`; `null` → `"—"`, never a fabricated score. */
export function formatPercent(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return EM_DASH;
  return `${Math.round(v * 100)}%`;
}

/** `0.0123` → `"$0.0123"`; a null batch cost renders the em dash (AC-49). */
export function formatCost(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return EM_DASH;
  return `$${v.toFixed(4)}`;
}

/**
 * Fraction → points, rounded **half away from zero**, matching the server's
 * alert rule (§8.4). JS `Math.round(-2.5)` is `-2` while `Math.round(2.5)` is
 * `3`, so the naive version would make the cards disagree with the banner.
 */
export function roundPts(delta: number): number {
  return Math.sign(delta) * Math.round(Math.abs(delta) * 100);
}

/** `head − base` as `▲4pt` / `▼4pt` / `=0pt`; `—` when either side is null. */
export function percentDelta(
  head: number | null | undefined,
  base: number | null | undefined,
): DeltaDisplay {
  if (head == null || base == null || !Number.isFinite(head) || !Number.isFinite(base)) {
    return { text: EM_DASH, tone: "none" };
  }
  const pts = roundPts(head - base);
  const tone: DeltaTone = pts > 0 ? "up" : pts < 0 ? "down" : "flat";
  return { text: `${GLYPH[tone]}${Math.abs(pts)}pt`, tone };
}

/** Deterministic UTC stamp — a locale string would make the table depend on the
    machine rendering it (and on the CI runner's timezone). */
export function formatRanAt(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Green when a metric moved the good way, red the bad way, muted otherwise.
    Always redundant with the glyph + "pt" text (AC-44). */
export function toneColor(tone: DeltaTone): string {
  if (tone === "up") return "var(--ok)";
  if (tone === "down") return "var(--crit)";
  return "var(--text-muted)";
}

/* ---------------------------------------------------------------- window -- */

/** `?days=` → the hook's window type. Anything unrecognised falls back to 30. */
export function parseWindow(raw: string | null | undefined): EvalWindowDays {
  if (raw === "all") return "all";
  const n = Number(raw);
  if (n === 7 || n === 30 || n === 90) return n;
  return 30;
}

/** The window as it is written into the URL. */
export function windowParam(days: EvalWindowDays): string {
  return String(days);
}

/* --------------------------------------------------------------- batches -- */

/** Newest first. Never mutates the array the query cache handed us. */
export function sortBatchesDesc(batches: readonly EvalBatchRecord[]): EvalBatchRecord[] {
  return [...batches].sort((a, b) => b.ran_at.localeCompare(a.ran_at));
}

/**
 * The window-filtered batches the metric cards read, oldest→newest and complete
 * only. The SERVER already applied `?days=` (§8.3, §19.2) — this narrows by
 * status and orders, it never re-filters by date, or the cards and the table
 * would disagree.
 */
export function completeBatchesAsc(batches: readonly EvalBatchRecord[]): EvalBatchRecord[] {
  return batches
    .filter((b) => b.status === "complete")
    .sort((a, b) => a.ran_at.localeCompare(b.ran_at));
}

/** `{ head, base }` = the newest complete batch and the one before it (§8.4). */
export function headAndBase(batches: readonly EvalBatchRecord[]): {
  head: EvalBatchRecord | null;
  base: EvalBatchRecord | null;
} {
  const asc = completeBatchesAsc(batches);
  return {
    head: asc[asc.length - 1] ?? null,
    base: asc[asc.length - 2] ?? null,
  };
}

type MetricField = "recall" | "precision" | "citation_accuracy";

const BATCH_METRIC: Record<TrendMetric, MetricField> = {
  recall: "recall",
  precision: "precision",
  citation: "citation_accuracy",
};

/** One card's sparkline: the metric across complete batches, oldest→newest,
    with null points skipped (§8.2). */
export function sparklineFor(
  batches: readonly EvalBatchRecord[],
  metric: TrendMetric,
): number[] {
  const key = BATCH_METRIC[metric];
  return completeBatchesAsc(batches)
    .map((b) => b[key])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

/** Finished vs total rows of a batch — the "Running… 7/20" numerator (AC-22). */
export function batchProgress(batch: EvalBatchRecord): { done: number; total: number } {
  return {
    done: batch.cases_passed + batch.cases_failed + batch.cases_errored,
    total: batch.cases_total,
  };
}

/* ----------------------------------------------------------------- trend -- */

const TREND_METRIC: Record<TrendMetric, MetricField> = {
  recall: "recall",
  precision: "precision",
  citation: "citation_accuracy",
};

/** One numeric series per metric. The server omits any point whose metric is
    null (plan §Concerns C4), so these are already clean numbers. */
export function trendSeries(
  trend: readonly EvalTrendPoint[],
  metric: TrendMetric,
): number[] {
  const key = TREND_METRIC[metric];
  return trend.map((p) => {
    const v = p[key];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  });
}

/** One point's value for a metric, for the single-point marker (AC-28). */
export function trendValue(point: EvalTrendPoint, metric: TrendMetric): number | null {
  const v = point[TREND_METRIC[metric]];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/* ------------------------------------------------------------- selection -- */

/**
 * Compare takes exactly two batches. Ticking an already-selected batch unticks
 * it; ticking a third drops the OLDEST tick, so the control never dead-ends on
 * "unselect something first".
 */
export function toggleCompareSelection(
  selected: readonly string[],
  batchId: string,
  max: number = MAX_COMPARE_SELECTION,
): string[] {
  if (selected.includes(batchId)) return selected.filter((id) => id !== batchId);
  const next = [...selected, batchId];
  return next.length > max ? next.slice(next.length - max) : next;
}

export interface ComparePair {
  baseBatchId: string;
  headBatchId: string;
}

/**
 * The two selected batches as `{ base = older, head = newer }`, or `null` when
 * compare must stay disabled: fewer than two selections, the same batch twice,
 * or two batches of different agents (the server answers 422 for both, §9.1).
 */
export function comparePair(
  batches: readonly EvalBatchRecord[],
  selected: readonly string[],
): ComparePair | null {
  if (selected.length !== 2) return null;
  const [a, b] = selected.map((id) => batches.find((x) => x.batch_id === id));
  if (!a || !b) return null;
  if (a.batch_id === b.batch_id) return null;
  if (a.agent_id !== b.agent_id) return null;
  const [base, head] = a.ran_at <= b.ran_at ? [a, b] : [b, a];
  return { baseBatchId: base.batch_id, headBatchId: head.batch_id };
}

/* ----------------------------------------------------------------- alert -- */

/** Contract metric id → the i18n suffix used by both `dashboard.alert.*` and
    `dashboard.legend.*`. */
export const ALERT_METRIC_KEY: Record<EvalAlertSignal["metric"], TrendMetric> = {
  recall: "recall",
  precision: "precision",
  citation_accuracy: "citation",
};

/** `{ metric: 'precision', direction: 'down' }` → `dashboard.alert.precisionDown`. */
export function primaryMessageKey(signal: EvalAlertSignal): string {
  const metric = ALERT_METRIC_KEY[signal.metric];
  const suffix = signal.direction === "down" ? "Down" : "Up";
  return `dashboard.alert.${metric}${suffix}`;
}

/** All up / all down / mixed — the three `dashboard.alert.others*` frames. */
export function othersMessageKey(others: readonly EvalAlertSignal[]): string {
  const up = others.filter((o) => o.direction === "up").length;
  if (up === others.length) return "dashboard.alert.othersUp";
  if (up === 0) return "dashboard.alert.othersDown";
  return "dashboard.alert.othersMixed";
}

/**
 * One secondary signal as `"Recall ▲3pt"`. The `others*` messages supply only
 * the sentence frame, so `{metrics}` must already carry the glyph and the
 * points text (AC-44) — colour is not available inside an ICU argument.
 */
export function signalText(signal: EvalAlertSignal, label: string): string {
  return `${label} ${GLYPH[signal.direction]}${Math.abs(signal.delta_pts)}pt`;
}
