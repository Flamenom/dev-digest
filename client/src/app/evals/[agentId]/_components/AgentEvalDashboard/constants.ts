/* constants.ts — every magic value screen C would otherwise hardcode
   (`specs/06-eval-pipeline.md` §8.3, §10 C). */

import type { EvalWindowDays } from "@/lib/hooks/eval";

/** The `?days=` key. URL-dependent state lives in the URL, not in `useState`. */
export const WINDOW_PARAM = "days";

/** The four window options of §8.3, in render order. `key` is the i18n suffix
    under `eval.dashboard.window.*`; `value` is what the hook sends as `?days=`. */
export const WINDOW_OPTIONS: readonly { value: EvalWindowDays; key: "7" | "30" | "90" | "all" }[] = [
  { value: 7, key: "7" },
  { value: 30, key: "30" },
  { value: 90, key: "90" },
  { value: "all", key: "all" },
] as const;

/** Compare takes exactly two batches (§9.1); ticking a third drops the oldest tick. */
export const MAX_COMPARE_SELECTION = 2;

/** The three trend series, in legend order. */
export const TREND_METRICS = ["recall", "precision", "citation"] as const;
export type TrendMetric = (typeof TREND_METRICS)[number];

/** Design D's y-axis window: metrics live in the top 40% of the range. */
export const TREND_Y_MIN = 0.6;
export const TREND_Y_MAX = 1.0;

/** One token per series, reused by the chart, the legend and the sparklines. */
export const SERIES_COLOR: Record<TrendMetric, string> = {
  recall: "var(--accent)",
  precision: "var(--ok)",
  citation: "var(--warn)",
};
