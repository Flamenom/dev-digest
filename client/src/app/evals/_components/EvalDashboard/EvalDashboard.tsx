/* EvalDashboard — screen B of the L06 eval pipeline (`/evals`, spec §10 B).

   States: skeletons → load error → "no agents with cases" empty state (AC-20)
   → populated (agent row-cards + the all-agents batch table). `▷ Run all
   agents` is one mutation whose result strip names every skipped agent and why
   (AC-34).

   DEEP LINK. The finding card's "Eval case ✓" state links here as
   `/evals?case=<case_uuid>` (decided by T20). The overview payload (C14) has no
   case→agent mapping, so the owning agent is resolved from the case itself:
   `useEvalCase(caseId).owner_id`. That is the same query key the editor modal
   uses, so React Query dedupes it into ONE request and the modal renders from
   an already-warm cache. The modal only mounts once `owner_id` is known —
   nothing is guessed. Closing it clears `?case=` from the URL. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, EmptyState, ErrorState, SectionLabel, Skeleton } from "@devdigest/ui";
import { useEvalCase, useEvalDashboard, useRunAllEvals } from "@/lib/hooks/eval";
import { useQueryParam } from "@/lib/hooks/use-query-param";
import { AppShell } from "@/components/app-shell";
import { EvalCaseEditorModal } from "@/components/EvalCaseEditorModal";
import { AgentRowCard } from "./_components/AgentRowCard";
import { RecentBatchesTable } from "./_components/RecentBatchesTable";
import { RunAllSummary } from "./_components/RunAllSummary";
import { s } from "./styles";

export function EvalDashboard() {
  const t = useTranslations("eval");
  const query = useEvalDashboard();
  const runAll = useRunAllEvals();

  // `?case=<uuid>` — the deep link from the finding card (T20).
  const [caseParam, setCaseParam] = useQueryParam("case");
  const deepLinkedCaseId = caseParam || null;
  const { data: deepLinkedCase } = useEvalCase(deepLinkedCaseId);
  const closeCaseEditor = React.useCallback(() => setCaseParam(null), [setCaseParam]);

  const agents = query.data?.agents ?? [];
  const recentBatches = query.data?.recent_batches ?? [];
  // Nothing to run until at least one agent owns at least one case (AC-20).
  const runnableAgents = agents.filter((a) => a.enabled && a.cases_total > 0);

  const crumb = [
    { label: t("page.crumbSkillsLab") },
    { label: t("page.crumbEvalDashboard"), href: "/evals" },
  ];

  let content: React.ReactNode;
  if (query.isLoading) {
    content = (
      <div style={s.skeletons}>
        <Skeleton height={28} width={320} />
        <Skeleton height={72} />
        <Skeleton height={72} />
        <Skeleton height={180} />
      </div>
    );
  } else if (query.isError) {
    content = (
      <div style={s.centered}>
        {/* No eval-namespace load-error copy exists (T4 owns the message file),
            so ErrorState's own default title carries it rather than
            mislabelling the failure with an unrelated key. */}
        <ErrorState onRetry={() => query.refetch()} />
      </div>
    );
  } else {
    // The header (and with it the Run control) stays mounted in the empty
    // state too: AC-20 wants the control DISABLED with an empty-state message,
    // not absent.
    content = (
      <div style={s.inner}>
        <div style={s.headerRow}>
          <div>
            <h1 style={s.heading}>{t("dashboard.defaultTitle")}</h1>
            <p style={s.subtitle}>{t("dashboard.subtitle")}</p>
          </div>
          <Button
            kind="primary"
            icon="Play"
            disabled={runnableAgents.length === 0}
            loading={runAll.isPending}
            onClick={() => runAll.mutate()}
          >
            {runAll.isPending ? t("dashboard.running") : t("dashboard.runAllAgents")}
          </Button>
        </div>

        {runAll.data && <RunAllSummary result={runAll.data} />}

        {agents.length === 0 ? (
          <EmptyState icon="Gauge" title={t("dashboard.noCases")} body={t("dashboard.noRuns")} />
        ) : (
          <>
            <section style={s.section}>
              <SectionLabel icon="Cpu">{t("dashboard.agentsHeading")}</SectionLabel>
              <div style={s.agentList}>
                {agents.map((summary) => (
                  <AgentRowCard key={summary.agent_id} summary={summary} />
                ))}
              </div>
            </section>

            <section style={s.section}>
              <SectionLabel icon="Gauge">{t("dashboard.recentAllAgents")}</SectionLabel>
              <RecentBatchesTable batches={recentBatches} />
            </section>
          </>
        )}
      </div>
    );
  }

  return (
    <AppShell crumb={crumb}>
      <div style={s.page}>{content}</div>
      {deepLinkedCaseId && deepLinkedCase && (
        <EvalCaseEditorModal
          caseId={deepLinkedCaseId}
          agentId={deepLinkedCase.owner_id}
          onClose={closeCaseEditor}
        />
      )}
    </AppShell>
  );
}

export default EvalDashboard;
