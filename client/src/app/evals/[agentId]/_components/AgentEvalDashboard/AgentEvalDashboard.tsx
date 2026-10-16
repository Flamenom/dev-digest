/* AgentEvalDashboard — screen C of the L06 eval pipeline
   (`specs/06-eval-pipeline.md` §10 C, §8.3, §8.4, §9.1).

   The drill-down for one agent: the date-range control, the alert banner, three
   metric cards, the metric trend and the recent-runs table with compare.

   Four invariants this file exists to hold:

   - **The window lives in the URL.** `?days=` is the single source of truth for
     the range control; the value is passed straight to the hooks as `?days=`
     and never mirrored into `useState` (react-best-practices).
   - **The server owns the filtering.** Everything below reads the payload the
     server already filtered by that window (§8.3, §19.2). Nothing here
     re-filters by date, or the cards and the table would disagree.
   - **The alert is composed here, not on the server.** The structured
     `EvalAlertDetail` (C16) goes through next-intl; the server's English
     `EvalDashboard.alert` fallback is deliberately ignored (§8.4).
   - **Never colour alone.** Every delta carries a glyph and its "pt" text
     (AC-44); a null metric renders `—`, never a vacuous score (AC-21). */
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, EmptyState, ErrorState, Skeleton } from "@devdigest/ui";
import { AppShell } from "@/components/app-shell";
import { ApiError } from "@/lib/api";
import { useQueryParam } from "@/lib/hooks/use-query-param";
import {
  EVAL_WINDOW_DAYS_DEFAULT,
  useAgentEvalDashboard,
  useEvalBatch,
  useEvalDashboard,
  useStartEvalBatch,
} from "@/lib/hooks/eval";
import { CompareModal } from "../../../_components/CompareModal";
import { WINDOW_PARAM } from "./constants";
import {
  batchProgress,
  comparePair,
  headAndBase,
  parseWindow,
  sortBatchesDesc,
  toggleCompareSelection,
  windowParam,
} from "./helpers";
import { AgentSwitcher } from "./_components/AgentSwitcher";
import { AlertBanner } from "./_components/AlertBanner";
import { MetricCards } from "./_components/MetricCards";
import { RecentRunsTable } from "./_components/RecentRunsTable";
import { TrendChart } from "./_components/TrendChart";
import { WindowControl } from "./_components/WindowControl";
import { s } from "./styles";

export interface AgentEvalDashboardProps {
  /** Agent row **uuid** — every eval API is keyed by uuid, never by a number. */
  agentId: string;
}

export function AgentEvalDashboard({ agentId }: AgentEvalDashboardProps) {
  const t = useTranslations("eval");
  const router = useRouter();

  // URL-dependent state: the window is read from and written to `?days=`.
  const [rawDays, setRawDays] = useQueryParam(
    WINDOW_PARAM,
    windowParam(EVAL_WINDOW_DAYS_DEFAULT),
  );
  const days = parseWindow(rawDays);

  const dashboard = useAgentEvalDashboard(agentId, days);
  const overview = useEvalDashboard();
  const startBatch = useStartEvalBatch();

  // The batch this page started in THIS session; a batch already running when
  // the page opened is picked up from the payload below instead.
  const [startedBatchId, setStartedBatchId] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [compareOpen, setCompareOpen] = React.useState(false);

  const data = dashboard.data;
  const batches = React.useMemo(() => sortBatchesDesc(data?.batches ?? []), [data?.batches]);
  const runningFromPayload = batches.find((b) => b.status === "running") ?? null;

  // One poller: whichever batch is live right now (§8.1 / AC-22). `useEvalBatch`
  // stops polling by itself once the batch leaves `running`.
  const watchedBatchId = startedBatchId ?? runningFromPayload?.batch_id ?? null;
  const polled = useEvalBatch(watchedBatchId);
  const liveBatch = polled.data ?? runningFromPayload;
  const runningBatch = liveBatch?.status === "running" ? liveBatch : null;

  // Derived, never stored: a selection can point at a batch that left the
  // window when the range control changed.
  const liveSelection = selected.filter((id) => batches.some((b) => b.batch_id === id));
  const pair = comparePair(batches, liveSelection);

  const { head, base } = headAndBase(batches);
  const casesTotal = data?.dashboard.cases_total ?? 0;
  const agentName = data?.agent.name ?? t("dashboard.defaultTitle");

  const crumb = [
    { label: t("page.crumbSkillsLab") },
    { label: t("page.crumbEvalDashboard"), href: "/evals" },
    { label: agentName },
  ];

  const onToggleBatch = (batchId: string) =>
    setSelected((current) => toggleCompareSelection(current, batchId));

  const onSelectAgent = (nextAgentId: string) => {
    if (nextAgentId === agentId) return;
    router.push(`/evals/${nextAgentId}?${WINDOW_PARAM}=${windowParam(days)}`);
  };

  if (dashboard.isError) {
    return (
      <AppShell crumb={crumb}>
        <ErrorState
          fullScreen
          title={t("dashboard.defaultTitle")}
          body={
            dashboard.error instanceof ApiError
              ? dashboard.error.message
              : t("dashboard.loading")
          }
          onRetry={() => dashboard.refetch()}
        />
      </AppShell>
    );
  }

  if (dashboard.isLoading || !data) {
    return (
      <AppShell crumb={crumb}>
        <div style={s.skeletons}>
          <Skeleton height={28} width={280} />
          <Skeleton height={96} />
          <Skeleton height={220} />
        </div>
      </AppShell>
    );
  }

  const progress = runningBatch ? batchProgress(runningBatch) : null;

  return (
    <AppShell crumb={crumb}>
      <div style={s.page}>
        <header style={s.header}>
          <Button
            kind="tertiary"
            size="sm"
            icon="ChevronLeft"
            onClick={() => router.push("/evals")}
          >
            {t("dashboard.allAgentsBack")}
          </Button>
          <div style={s.titleBlock}>
            <h1 style={s.title}>{agentName}</h1>
            <p style={s.subtitle}>
              {`${t("dashboard.version", { version: data.agent.version })} · ${data.agent.model}`}
            </p>
          </div>
          <div style={s.headerActions}>
            <AgentSwitcher
              agentId={agentId}
              agents={(overview.data?.agents ?? []).map((a) => ({
                id: a.agent_id,
                name: a.name,
              }))}
              onSelect={onSelectAgent}
            />
            <WindowControl
              value={days}
              onChange={(next) => setRawDays(windowParam(next))}
            />
            <Button
              kind="primary"
              icon="Play"
              disabled={progress !== null || startBatch.isPending || casesTotal === 0}
              onClick={() =>
                startBatch.mutate(
                  { agentId },
                  { onSuccess: (started) => setStartedBatchId(started.batch_id) },
                )
              }
            >
              {progress === null
                ? t("dashboard.runEval", { count: casesTotal })
                : `${t("dashboard.running")} ${progress.done}/${progress.total}`}
            </Button>
          </div>
        </header>

        {data.alert === null ? null : (
          <AlertBanner detail={data.alert} fallbackVersion={data.agent.version} />
        )}

        {batches.length === 0 ? (
          <EmptyState
            icon="FlaskConical"
            title={
              days === "all"
                ? t("dashboard.noRuns")
                : t("dashboard.noRunsInWindow", { days })
            }
            body={casesTotal === 0 ? t("dashboard.noCases") : undefined}
          />
        ) : (
          <>
            <MetricCards head={head} base={base} batches={batches} />
            <TrendChart trend={data.dashboard.trend} />
            <RecentRunsTable
              batches={batches}
              selected={liveSelection}
              onToggle={onToggleBatch}
              onCompare={() => setCompareOpen(true)}
              compareDisabled={pair === null}
            />
          </>
        )}
      </div>

      {compareOpen && pair !== null ? (
        <CompareModal
          baseBatchId={pair.baseBatchId}
          headBatchId={pair.headBatchId}
          agentId={agentId}
          // The agent's LIVE version — `EvalCompare` only carries the two
          // batches' historical ones, and the promote copy needs "the agent is
          // at vN, so this creates vN+1" (§9.2).
          currentVersion={data.agent.version}
          onClose={() => setCompareOpen(false)}
        />
      ) : null}
    </AppShell>
  );
}

export default AgentEvalDashboard;
