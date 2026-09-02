/* constants.ts — EvalsTab magic values, named so nothing bare appears in JSX. */

import type { IconName } from "@devdigest/ui";

/** Rendered wherever a metric is absent — never a vacuous `0%` / `1.0` (AC-21). */
export const EM_DASH = "—";

/** Which of `EvalBatchRecord`'s three micro-averaged metrics gets a card. */
export type MetricKey = "recall" | "precision" | "citation_accuracy";

export interface MetricCardDef {
  key: MetricKey;
  /** Resolved under the `eval` namespace. */
  labelKey: string;
  color: string;
}

/**
 * The three metric cards of `⌾ EVAL METRICS`, in the spec's reading order
 * (§10 E). A fourth COST card is appended by the component — it is not a
 * micro-average, so it does not share this descriptor's shape.
 */
export const METRIC_CARDS: readonly MetricCardDef[] = [
  { key: "recall", labelKey: "dashboard.metrics.recall", color: "var(--accent)" },
  { key: "precision", labelKey: "dashboard.metrics.precision", color: "var(--ok)" },
  { key: "citation_accuracy", labelKey: "dashboard.metrics.citationAccuracy", color: "var(--warn)" },
];

/** A sparkline of one point is a dot, not a trend — hide it below this. */
export const MIN_TREND_POINTS = 2;

/** Status glyph per case outcome. Colour is never the only carrier — every icon
    also gets an `aria-label` and the row keeps a text sub-line (AC-44, §14). */
export const STATUS_ICON: Record<"pass" | "fail" | "errored" | "pending" | "never", IconName> = {
  pass: "CheckCircle",
  fail: "XCircle",
  errored: "AlertTriangle",
  pending: "RefreshCw",
  never: "Dot",
};

export const STATUS_COLOR: Record<keyof typeof STATUS_ICON, string> = {
  pass: "var(--ok)",
  fail: "var(--crit)",
  errored: "var(--warn)",
  pending: "var(--text-secondary)",
  never: "var(--text-muted)",
};

/** Server error codes this tab can localise; anything else renders verbatim. */
export const ERROR_CODE_KEYS: Record<string, string> = {
  empty_diff: "errors.emptyDiff",
  batch_already_running: "errors.batchAlreadyRunning",
  no_cases: "errors.noCases",
  too_many_cases: "errors.tooManyCases",
};
