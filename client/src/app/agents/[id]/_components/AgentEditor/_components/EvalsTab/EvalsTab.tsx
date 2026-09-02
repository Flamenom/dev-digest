/* EvalsTab — screen E of the L06 eval pipeline (spec §10 E).

   `⌾ EVAL METRICS` (+ `View full dashboard →` into /evals/:agentId), four metric
   cards read from the agent's latest COMPLETE batch, then `Eval cases` with an
   `N / M passing` pill, `▷ Run all evals`, `+ New eval case` and one row per
   case.

   Two rules this file exists to honour:
     - metric tiles read `EvalBatchRecord` (C10), whose metrics are honestly
       `null` on a zero denominator, NOT the frozen `EvalDashboard.current`,
       whose vacuous-perfect `1.0` must never be displayed as a score (AC-21);
     - while a batch is in flight the rows flip to their own result as each case
       finishes (§19.6) — the tab polls the batch's `eval_runs` rows and merges
       them over each case's persisted `last_run`. */
"use client";

import React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Badge, Button, EmptyState, Icon, MetricCard, SectionLabel, Skeleton } from "@devdigest/ui";
import type { Agent } from "@devdigest/shared";
import {
  useAgentEvalCases,
  useAgentEvalDashboard,
  useAgentEvalRuns,
  useDeleteEvalCase,
  useRunEvalCase,
  useStartEvalBatch,
} from "@/lib/hooks/eval";
import { EvalCaseEditorModal } from "@/components/EvalCaseEditorModal";
import { CaseRow } from "./_components/CaseRow";
import { EM_DASH, ERROR_CODE_KEYS, METRIC_CARDS } from "./constants";
import {
  batchProgress,
  errorCode,
  formatCost,
  formatPercent,
  formatRanAt,
  latestCompleteBatch,
  passingCounts,
  readCaseHasRunsCount,
  resultForCase,
  runsByCase,
  statusOf,
  trendOf,
} from "./helpers";
import { s } from "./styles";

/** `{ caseId: null }` = author a new case; `null` = the editor is closed. */
type EditorTarget = { caseId: string | null } | null;

const SKELETON_ROWS = 3;

export function EvalsTab({ agent }: { agent: Agent }) {
  const t = useTranslations("eval");

  // The batch this tab started, if any. Kept after it finishes so the rows keep
  // showing that batch's results until the case list is refetched.
  const [batchId, setBatchId] = React.useState<string | null>(null);
  const [batchError, setBatchError] = React.useState<string | null>(null);
  const [editor, setEditor] = React.useState<EditorTarget>(null);
  /** Set only by a 409 `case_has_runs`; `null` = no confirmation pending. */
  const [pendingDelete, setPendingDelete] = React.useState<{ caseId: string; runCount: number } | null>(null);

  const casesQ = useAgentEvalCases(agent.id);
  const dashQ = useAgentEvalDashboard(agent.id);
  const startBatch = useStartEvalBatch();
  const runCase = useRunEvalCase();
  const removeCase = useDeleteEvalCase();

  // Only fetch run rows while this tab has a batch — passing `null` disables the
  // query, so an idle tab never pulls the agent's whole run history (which would
  // otherwise be merged over `last_run` and show the wrong result per case).
  const runsQ = useAgentEvalRuns(batchId ? agent.id : null, {
    batchId: batchId ?? undefined,
    poll: true,
  });

  // --- derived during render (never mirrored into state) --------------------
  const cases = casesQ.data ?? [];
  const liveRuns = batchId ? runsQ.data : undefined;
  const byCase = runsByCase(liveRuns);
  const rows = cases.map((record) => {
    const result = resultForCase(record, byCase.get(record.id));
    return { record, result, status: statusOf(result) };
  });
  const pill = passingCounts(rows.map((r) => r.result));
  const progress = batchProgress(liveRuns);
  // A batch that has inserted rows and still has a pending one is in flight; a
  // freshly started batch (no rows yet) counts as running too.
  const running =
    batchId != null && (progress.total === 0 || progress.finished < progress.total);

  const batch = latestCompleteBatch(dashQ.data?.batches);
  const trend = dashQ.data?.dashboard.trend;
  const hasCases = cases.length > 0;
  const runDisabled = !hasCases || running || startBatch.isPending;

  // --- actions --------------------------------------------------------------
  const onRunAll = () => {
    setBatchError(null);
    startBatch.mutate(
      { agentId: agent.id },
      {
        onSuccess: (started) => setBatchId(started.batch_id),
        onError: (error) => setBatchError(errorCode(error) ?? "noCases"),
      },
    );
  };

  const onDelete = (caseId: string, force: boolean) => {
    removeCase.mutate(
      { caseId, agentId: agent.id, force },
      {
        onSuccess: () => setPendingDelete(null),
        onError: (error) => {
          const runCount = readCaseHasRunsCount(error);
          if (runCount != null) setPendingDelete({ caseId, runCount });
        },
      },
    );
  };

  const batchErrorText = batchError
    ? ERROR_CODE_KEYS[batchError]
      ? t(ERROR_CODE_KEYS[batchError]!)
      : batchError
    : null;

  return (
    <div style={s.wrap}>
      {/* ── ⌾ EVAL METRICS ─────────────────────────────────────────────── */}
      <section style={s.section}>
        <SectionLabel
          icon="Target"
          right={
            <Link href={`/evals/${agent.id}`} style={s.dashboardLink}>
              {t("evalsTab.viewFullDashboard")}
            </Link>
          }
        >
          {t("evalsTab.metricsTitle")}
        </SectionLabel>
        <p style={s.subtitle}>{t("evalsTab.metricsSubtitle")}</p>
        <div style={s.cards}>
          {METRIC_CARDS.map((card) => (
            <MetricCard
              key={card.key}
              label={t(card.labelKey)}
              value={formatPercent(batch?.[card.key] ?? null)}
              color={card.color}
              trend={trendOf(trend, card.key)}
            />
          ))}
          {/* Cost is money, not a micro-average — same tile, different formatter.
              Upper-cased to sit level with the three metric labels; `en` is the
              only locale this app ships (§10.1). */}
          <MetricCard
            label={t("dashboard.table.cost").toUpperCase()}
            value={formatCost(batch?.cost_usd ?? null)}
            color="var(--text-secondary)"
          />
        </div>
        <div style={s.batchLine}>
          {batch ? (
            <>
              <span>{t("evalsTab.tracesPassed", { passed: batch.cases_passed, total: batch.cases_total })}</span>
              <span>·</span>
              <span>{t("dashboard.version", { version: batch.agent_version ?? EM_DASH })}</span>
              <span>·</span>
              <span className="tnum">{formatRanAt(batch.ran_at)}</span>
            </>
          ) : (
            <span>{dashQ.isLoading ? t("dashboard.loading") : t("dashboard.noRuns")}</span>
          )}
        </div>
      </section>

      {/* ── Eval cases ─────────────────────────────────────────────────── */}
      <section style={s.section}>
        <div style={s.casesHeader}>
          <h2 style={s.h2}>{t("evalsTab.casesHeading")}</h2>
          <Badge>{t("evalsTab.passingPill", { passed: pill.passed, total: pill.total })}</Badge>
          <div style={s.headerActions}>
            {running && (
              <span style={s.progress} className="tnum" aria-live="polite">
                {progress.total > 0 ? `${progress.finished}/${progress.total}` : null}
              </span>
            )}
            <Button
              kind="secondary"
              size="sm"
              icon="Play"
              onClick={onRunAll}
              disabled={runDisabled}
              loading={running || startBatch.isPending}
            >
              {running ? t("dashboard.running") : t("evalsTab.runAll")}
            </Button>
            <Button kind="primary" size="sm" icon="Plus" onClick={() => setEditor({ caseId: null })}>
              {t("evalsTab.newCase")}
            </Button>
          </div>
        </div>

        {batchErrorText && (
          <div style={s.banner} role="alert">
            <Icon.AlertTriangle size={15} style={{ color: "var(--warn)" }} />
            <span>{batchErrorText}</span>
          </div>
        )}

        {pendingDelete && (
          <div style={s.confirm} role="alert">
            <span>{t("caseEditor.deleteConfirmWithRuns", { count: pendingDelete.runCount })}</span>
            <Button kind="tertiary" size="sm" onClick={() => setPendingDelete(null)}>
              {t("caseEditor.cancel")}
            </Button>
            <Button kind="danger" size="sm" icon="Trash" onClick={() => onDelete(pendingDelete.caseId, true)}>
              {t("caseEditor.delete")}
            </Button>
          </div>
        )}

        {casesQ.isLoading ? (
          <div style={s.skeletons} aria-label={t("evalsTab.loadingCases")}>
            {Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <Skeleton key={i} height={46} />
            ))}
          </div>
        ) : hasCases ? (
          <ul style={s.list}>
            {rows.map(({ record, result, status }) => (
              <CaseRow
                key={record.id}
                record={record}
                result={result}
                status={status}
                busy={running || runCase.isPending}
                onRun={() => runCase.mutate({ caseId: record.id, agentId: agent.id })}
                onEdit={() => setEditor({ caseId: record.id })}
                onDelete={() => onDelete(record.id, false)}
                t={t}
              />
            ))}
          </ul>
        ) : (
          <EmptyState
            icon="FlaskConical"
            title={t("dashboard.noCases")}
            body={t("evalsTab.emptyCases")}
            cta={t("evalsTab.newCase")}
            onCta={() => setEditor({ caseId: null })}
          />
        )}
      </section>

      {editor && (
        <EvalCaseEditorModal
          caseId={editor.caseId}
          agentId={agent.id}
          onClose={() => setEditor(null)}
          onSaved={() => setEditor(null)}
        />
      )}
    </div>
  );
}
