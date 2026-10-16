/* Constants for the /evals overview (screen B). No magic values in JSX. */

import type { EvalRunAllResult } from "@devdigest/shared";

/** The three micro-averaged metrics, in the order the row-card columns show them. */
export const CARD_METRICS = ["recall", "precision", "citation_accuracy"] as const;
export type CardMetric = (typeof CARD_METRICS)[number];

/** `eval.dashboard.metrics.*` key per metric (the message file is owned by T4). */
export const METRIC_LABEL_KEY: Record<CardMetric, string> = {
  recall: "dashboard.metrics.recall",
  precision: "dashboard.metrics.precision",
  citation_accuracy: "dashboard.metrics.citationAccuracy",
};

/** Rendered when a metric's denominator was zero (AC-21: never a vacuous score). */
export const EMPTY_METRIC = "—";

/** `run-all` skip reasons → an existing message key. */
type SkipReason = EvalRunAllResult["skipped"][number]["reason"];

/** Reasons whose copy lives in the `eval` namespace. */
export const SKIP_REASON_KEY: Record<Exclude<SkipReason, "disabled">, string> = {
  no_cases: "dashboard.noCases",
  already_running: "errors.batchAlreadyRunning",
};

/** Width of the recall sparkline on an agent row-card. */
export const SPARKLINE_W = 92;
export const SPARKLINE_H = 26;

/** Columns the running-batch progress cell replaces in the recent-runs table. */
export const RUNNING_CELL_SPAN = 5;
