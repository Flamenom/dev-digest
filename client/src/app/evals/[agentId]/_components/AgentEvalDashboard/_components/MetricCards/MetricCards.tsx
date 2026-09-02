/* MetricCards — RECALL / PRECISION / CITATION ACCURACY for the newest COMPLETE
   batch in the window, with the delta against the batch before it (§8.3, §8.4).

   Two rules this file exists to hold:

   - A `null` metric renders `—`, never a vacuous score (AC-21). The coerced
     `EvalDashboard.current` numbers are contract filler and are deliberately
     NOT read here; the honest values live on `EvalBatchRecord` (C10).
   - Every delta carries a glyph and the "pt" text, so the green/red is
     redundant (AC-44). The shared `MetricCard`'s own colour-only delta prop is
     therefore left unused; the delta is rendered inside `value` instead. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { MetricCard } from "@devdigest/ui";
import type { EvalBatchRecord } from "@devdigest/shared";
import { SERIES_COLOR, TREND_METRICS, type TrendMetric } from "../../constants";
import { formatPercent, percentDelta, sparklineFor, type DeltaDisplay } from "../../helpers";
import { s } from "./styles";

/** i18n suffix under `eval.dashboard.metrics.*` per series. */
const LABEL_KEY: Record<TrendMetric, string> = {
  recall: "recall",
  precision: "precision",
  citation: "citationAccuracy",
};

const FIELD: Record<TrendMetric, "recall" | "precision" | "citation_accuracy"> = {
  recall: "recall",
  precision: "precision",
  citation: "citation_accuracy",
};

function MetricValue({ text, delta }: { text: string; delta: DeltaDisplay }) {
  return (
    <span style={s.value}>
      <span>{text}</span>
      {delta.tone === "none" ? null : <span style={s.delta(delta.tone)}>{delta.text}</span>}
    </span>
  );
}

export interface MetricCardsProps {
  /** Newest complete batch in the window; `null` when there is none. */
  head: EvalBatchRecord | null;
  /** The complete batch before it — the delta's baseline. */
  base: EvalBatchRecord | null;
  /** Every batch in the window; the sparklines are derived from it. */
  batches: readonly EvalBatchRecord[];
}

export function MetricCards({ head, base, batches }: MetricCardsProps) {
  const t = useTranslations("eval");
  return (
    <div style={s.row}>
      {TREND_METRICS.map((metric) => {
        const field = FIELD[metric];
        const trend = sparklineFor(batches, metric);
        return (
          <div key={metric} style={s.card}>
            <MetricCard
              label={t(`dashboard.metrics.${LABEL_KEY[metric]}`)}
              color={SERIES_COLOR[metric]}
              trend={trend.length > 1 ? trend : undefined}
              value={
                <MetricValue
                  text={formatPercent(head?.[field])}
                  delta={percentDelta(head?.[field], base?.[field])}
                />
              }
            />
          </div>
        );
      })}
    </div>
  );
}

export default MetricCards;
