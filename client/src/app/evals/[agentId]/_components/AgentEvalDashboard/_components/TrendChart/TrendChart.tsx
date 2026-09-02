/* TrendChart — the `METRIC TREND` block (design C).

   Three states, because a line chart cannot honestly draw the first two
   (AC-28):

     0 points → an empty state instead of a bare axis;
     1 point  → a VISIBLE marker per series (a polyline of one point renders
                nothing, and `LineChart` disables dots);
     2+       → the shared recharts `LineChart`, y 0.6 → 1.0.

   The points come straight from `EvalDashboard.trend`, which the server already
   filtered by `?days=` and already stripped of null metrics (plan §Concerns C4)
   — the client must not re-filter, or the chart and the table would disagree. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { EmptyState, LineChart, SectionLabel } from "@devdigest/ui";
import type { EvalTrendPoint } from "@devdigest/shared";
import {
  SERIES_COLOR,
  TREND_METRICS,
  TREND_Y_MAX,
  TREND_Y_MIN,
  type TrendMetric,
} from "../../constants";
import { formatPercent, trendSeries, trendValue } from "../../helpers";
import { s } from "./styles";

function Legend() {
  const t = useTranslations("eval");
  return (
    <div style={s.legend}>
      {TREND_METRICS.map((metric) => (
        <span key={metric} style={s.legendItem}>
          <span aria-hidden style={s.swatch(SERIES_COLOR[metric])} />
          {t(`dashboard.legend.${metric}`)}
        </span>
      ))}
    </div>
  );
}

function SinglePointMarker({ point }: { point: EvalTrendPoint }) {
  const t = useTranslations("eval");
  return (
    <div style={s.singlePoint}>
      {TREND_METRICS.map((metric: TrendMetric) => (
        <span key={metric} style={s.marker}>
          <span aria-hidden style={s.dot(SERIES_COLOR[metric])} />
          {`${t(`dashboard.legend.${metric}`)} ${formatPercent(trendValue(point, metric))}`}
        </span>
      ))}
    </div>
  );
}

export interface TrendChartProps {
  trend: readonly EvalTrendPoint[];
}

export function TrendChart({ trend }: TrendChartProps) {
  const t = useTranslations("eval");
  const heading = t("dashboard.metricTrend");

  return (
    <section aria-label={heading} style={s.section}>
      <SectionLabel icon="TrendingUp" right={<Legend />}>
        {heading}
      </SectionLabel>
      {trend.length === 0 ? (
        <EmptyState icon="BarChart" title={t("dashboard.noRuns")} />
      ) : trend.length === 1 ? (
        <SinglePointMarker point={trend[0]!} />
      ) : (
        <LineChart
          yMin={TREND_Y_MIN}
          yMax={TREND_Y_MAX}
          series={TREND_METRICS.map((metric) => ({
            name: t(`dashboard.legend.${metric}`),
            color: SERIES_COLOR[metric],
            data: trendSeries(trend, metric),
          }))}
        />
      )}
    </section>
  );
}

export default TrendChart;
