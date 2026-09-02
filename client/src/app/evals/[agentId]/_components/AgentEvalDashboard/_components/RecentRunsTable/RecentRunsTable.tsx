/* RecentRunsTable — the `RECENT RUNS` table of design C, with the compare
   checkboxes.

   Rules held here:

   - The rows are exactly what the server returned for the current `?days=`
     window. No client-side re-filtering (§8.3, §19.2), or this table and the
     metric cards above it would disagree.
   - A `running` batch reports partial counts, so it renders progress instead
     of numbers (AC-22).
   - Only COMPLETE batches carry a checkbox: comparing a half-finished batch
     would compare a moving target. Selection is capped at two by the parent's
     pure `toggleCompareSelection`. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, Checkbox, SectionLabel } from "@devdigest/ui";
import type { EvalBatchRecord } from "@devdigest/shared";
import { batchProgress, formatCost, formatPercent, formatRanAt } from "../../helpers";
import { s } from "./styles";

export interface RecentRunsTableProps {
  /** Newest first, already window-filtered by the server. */
  batches: readonly EvalBatchRecord[];
  selected: readonly string[];
  onToggle: (batchId: string) => void;
  onCompare: () => void;
  /** True until exactly two distinct, same-agent batches are selected (§9.1). */
  compareDisabled: boolean;
}

export function RecentRunsTable({
  batches,
  selected,
  onToggle,
  onCompare,
  compareDisabled,
}: RecentRunsTableProps) {
  const t = useTranslations("eval");
  const heading = t("dashboard.recentRuns");

  return (
    <section aria-label={heading} style={s.section}>
      <SectionLabel
        icon="History"
        right={
          <div style={s.actions}>
            {compareDisabled ? <span style={s.hint}>{t("compare.selectTwo")}</span> : null}
            <Button size="sm" icon="Layers" disabled={compareDisabled} onClick={onCompare}>
              {t("compare.title")}
            </Button>
          </div>
        }
      >
        {heading}
      </SectionLabel>

      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th} scope="col" aria-label={t("compare.title")} />
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
          {batches.map((batch) => {
            const running = batch.status === "running";
            const progress = batchProgress(batch);
            return (
              <tr key={batch.batch_id}>
                <td style={s.tdCheck}>
                  {running ? null : (
                    <Checkbox
                      checked={selected.includes(batch.batch_id)}
                      onChange={() => onToggle(batch.batch_id)}
                    />
                  )}
                </td>
                <td style={s.td}>
                  {formatRanAt(batch.ran_at)}
                  {batch.agent_version == null ? null : (
                    <span style={s.version}>
                      {t("dashboard.version", { version: batch.agent_version })}
                    </span>
                  )}
                </td>
                {running ? (
                  <td style={s.running} colSpan={5}>
                    {`${t("dashboard.running")} ${progress.done}/${progress.total}`}
                  </td>
                ) : (
                  <>
                    <td style={s.tdNum}>{formatPercent(batch.recall)}</td>
                    <td style={s.tdNum}>{formatPercent(batch.precision)}</td>
                    <td style={s.tdNum}>{formatPercent(batch.citation_accuracy)}</td>
                    <td style={s.tdNum}>{`${batch.cases_passed}/${batch.cases_total}`}</td>
                    <td style={s.tdNum}>{formatCost(batch.cost_usd)}</td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

export default RecentRunsTable;
