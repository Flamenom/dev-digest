/* AgentRowCard — one agent row on /evals (spec §10 B).

   Icon · name · model badge · sub-line (`Last run v7 · 2h ago · 17/20 pass`) ·
   recall sparkline · RECALL / PRECISION / CITATION stat columns · chevron to
   the drill-down. The whole card is the link.

   Two states replace the stat columns:
     - `cases_total === 0`  → "No eval cases" (AC-20)
     - the batch is running → a progress indicator, never partial numbers (AC-22)

   Card metrics come from `last_batch`, which the server already narrows to the
   agent's LATEST COMPLETE batch (§8.2) — this component must not widen that. */
"use client";

import React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Badge, Card, Icon, ProgressBar, Sparkline } from "@devdigest/ui";
import type { EvalAgentSummary } from "@devdigest/shared";
import {
  CARD_METRICS,
  METRIC_LABEL_KEY,
  SPARKLINE_H,
  SPARKLINE_W,
} from "../../constants";
import { batchProgress, formatMetric, isRunning, relativeTime } from "../../helpers";
import { c } from "../../styles";

export interface AgentRowCardProps {
  summary: EvalAgentSummary;
}

export function AgentRowCard({ summary }: AgentRowCardProps) {
  const t = useTranslations("eval");
  const tAgents = useTranslations("agents");
  const batch = summary.last_batch;
  const running = isRunning(batch);
  const progress = batch ? batchProgress(batch) : null;

  let subLine: string;
  if (summary.cases_total === 0) {
    subLine = t("dashboard.noCases");
  } else if (batch) {
    subLine = t("dashboard.lastRun", {
      version: batch.agent_version ?? summary.version,
      ranAt: relativeTime(batch.ran_at),
      passed: batch.cases_passed,
      total: batch.cases_total,
    });
  } else {
    subLine = t("dashboard.noRuns");
  }

  return (
    <Link href={`/evals/${summary.agent_id}`} style={c.link} aria-label={summary.name}>
      <Card hover pad={false} style={c.card}>
        <Icon.Cpu size={18} style={c.agentIcon} />

        <div style={c.identity}>
          <div style={c.titleRow}>
            <span style={c.name}>{summary.name}</span>
            <Badge mono color="var(--text-secondary)">
              {summary.model}
            </Badge>
            {!summary.enabled && (
              <Badge color="var(--text-muted)">{tAgents("editor.disabled")}</Badge>
            )}
          </div>
          <span style={c.subLine}>{subLine}</span>
        </div>

        {summary.sparkline.length > 0 && !running && (
          <Sparkline data={summary.sparkline} w={SPARKLINE_W} h={SPARKLINE_H} />
        )}

        {running && progress ? (
          <RunningProgress
            done={progress.done}
            total={progress.total}
            pct={progress.pct}
            label={t("dashboard.running")}
          />
        ) : (
          <div style={c.stats}>
            {CARD_METRICS.map((metric) => (
              <div key={metric} style={c.stat}>
                <span style={c.statLabel}>{t(METRIC_LABEL_KEY[metric])}</span>
                <span className="tnum" style={c.statValue}>
                  {formatMetric(batch ? batch[metric] : null)}
                </span>
              </div>
            ))}
          </div>
        )}

        <Icon.ChevronRight size={16} style={c.chevron} />
      </Card>
    </Link>
  );
}

/** Progress in place of metric values while a batch is still executing (AC-22). */
function RunningProgress({
  done,
  total,
  pct,
  label,
}: {
  done: number;
  total: number;
  pct: number;
  label: string;
}) {
  return (
    <div style={c.progress}>
      <span style={c.progressLabel}>
        <Icon.RefreshCw size={12} />
        {label}
        <span className="tnum">
          {done}/{total}
        </span>
      </span>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={total}
      >
        <ProgressBar value={pct} />
      </div>
    </div>
  );
}

export default AgentRowCard;
