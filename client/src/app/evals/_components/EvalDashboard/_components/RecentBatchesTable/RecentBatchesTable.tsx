/* RecentBatchesTable — `RECENT EVAL RUNS · ALL AGENTS` (spec §10 B).

   A real <table>: the rows are tabular data, and the semantics give RTL
   `role="row"` / `role="cell"` for free.

   A `running` batch reports partial counts (§8.1), so its metric cells are
   replaced by one progress cell — never a half-computed number (AC-22). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon, ProgressBar } from "@devdigest/ui";
import type { EvalBatchRecord } from "@devdigest/shared";
import { RUNNING_CELL_SPAN } from "../../constants";
import { batchProgress, formatCost, formatMetric, isRunning, relativeTime } from "../../helpers";
import { s } from "../../styles";

export interface RecentBatchesTableProps {
  batches: EvalBatchRecord[];
}

export function RecentBatchesTable({ batches }: RecentBatchesTableProps) {
  const t = useTranslations("eval");

  return (
    <div style={s.tableWrap}>
      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th} scope="col">
              {t("dashboard.agentsHeading")}
            </th>
            <th style={s.th} scope="col">
              {t("dashboard.table.ranAt")}
            </th>
            <th style={s.thNum} scope="col">
              {t("dashboard.table.recall")}
            </th>
            <th style={s.thNum} scope="col">
              {t("dashboard.table.precision")}
            </th>
            <th style={s.thNum} scope="col">
              {t("dashboard.table.citation")}
            </th>
            <th style={s.thNum} scope="col">
              {t("dashboard.table.pass")}
            </th>
            <th style={s.thNum} scope="col">
              {t("dashboard.table.cost")}
            </th>
          </tr>
        </thead>
        <tbody>
          {batches.length === 0 ? (
            <tr>
              <td style={s.emptyRow} colSpan={RUNNING_CELL_SPAN + 2}>
                {t("dashboard.noRuns")}
              </td>
            </tr>
          ) : (
            batches.map((batch) => <BatchRow key={batch.batch_id} batch={batch} />)
          )}
        </tbody>
      </table>
    </div>
  );
}

function BatchRow({ batch }: { batch: EvalBatchRecord }) {
  const t = useTranslations("eval");
  const running = isRunning(batch);
  const progress = batchProgress(batch);
  const version = batch.agent_version;

  return (
    <tr>
      <td style={s.tdAgent}>{batch.agent_name}</td>
      <td style={s.td}>
        {relativeTime(batch.ran_at)}
        {version != null && (
          <span style={s.tdVersion}>
            {t("dashboard.version", { version })}
          </span>
        )}
      </td>
      {running ? (
        <td style={s.runningCell} colSpan={RUNNING_CELL_SPAN}>
          <div style={s.runningInner}>
            <span style={s.runningLabel}>
              <Icon.RefreshCw size={12} style={s.runningIcon} />
              {t("dashboard.running")}
            </span>
            <div
              style={s.runningBar}
              role="progressbar"
              aria-label={`${batch.agent_name} — ${t("dashboard.running")}`}
              aria-valuenow={progress.done}
              aria-valuemin={0}
              aria-valuemax={progress.total}
            >
              <ProgressBar value={progress.pct} />
            </div>
            <span className="tnum" style={s.runningCount}>
              {progress.done}/{progress.total}
            </span>
          </div>
        </td>
      ) : (
        <>
          <td className="tnum" style={s.tdNum}>
            {formatMetric(batch.recall)}
          </td>
          <td className="tnum" style={s.tdNum}>
            {formatMetric(batch.precision)}
          </td>
          <td className="tnum" style={s.tdNum}>
            {formatMetric(batch.citation_accuracy)}
          </td>
          <td className="tnum" style={s.tdNum}>
            {batch.cases_passed}/{batch.cases_total}
          </td>
          <td className="tnum" style={s.tdNum}>
            {formatCost(batch.cost_usd)}
          </td>
        </>
      )}
    </tr>
  );
}

export default RecentBatchesTable;
