/* PR Detail — /repos/:repoId/pulls/:number. F2 shell extended by A2 with:
   - Findings panel (VerdictBanner + FindingCards)
   - RunReviewDropdown (run all / a specific agent) + live SSE RunStatus
   - Basic file-by-file diff viewer in the Files tab
   Tab state lives in query (?tab). */
"use client";

import { useParams } from "next/navigation";
import { Skeleton, ErrorState } from "@devdigest/ui";
import { AppShell } from "@/components/app-shell";
import { RepoNotFound } from "@/components/repo-not-found";
import { PrDetailHeader } from "./_components/PrDetailHeader";
import { OverviewTab } from "./_components/OverviewTab";
import { FindingsTab } from "./_components/FindingsTab";
import { DiffTab } from "./_components/DiffTab";
import RunTraceDrawer from "./_components/RunTraceDrawer";
import { usePullDetail, usePulls, useQueryParam, useSetQueryParams } from "@/lib/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { usePrReviews, useCancelRun, usePrActiveRuns, usePrRuns, useDeleteRun } from "@/lib/hooks/reviews";
import { useActiveRepo, useRepoNotFound } from "@/lib/repo-context";
import { ApiError } from "@/lib/api";
import { hostBlobUrl, hostLabelKey, hostPrUrl, isReadOnlyHost } from "@/lib/host-urls";
import type { FindingRecord } from "@devdigest/shared";

export default function PRDetailPage() {
  const params = useParams<{ repoId: string; number: string }>();
  const { repoId, number } = params;
  // The repo DTO carries provider/host/web_url — every external link on this
  // page is built from it through `host-urls` (AC-36/37/38).
  // Same source as the list page: the active repo is resolved from :repoId.
  const { activeRepo: repo, reposLoading } = useActiveRepo();
  // GitLab accepts no posted comments in the MVP (server: `provider_read_only`).
  const readOnly = isReadOnlyHost(repo);
  const repoNotFound = useRepoNotFound(repoId);
  // The route is keyed by PR number, but every PR API is keyed by the row's
  // uuid — resolve number → uuid via the (cached) pulls list before fetching.
  const { data: pulls, isLoading: pullsLoading } = usePulls(repoId);
  const prId = pulls?.find((p) => p.number === Number(number))?.id ?? null;
  const { data: pr, isLoading: detailLoading, isError, error, refetch } = usePullDetail(prId);

  const isLoading = reposLoading || pullsLoading || (prId != null && detailLoading);
  const { data: reviews, refetch: refetchReviews } = usePrReviews(prId);

  // Live run tracking is SERVER-SOURCED (agent_runs status='running'): survives
  // navigation AND reload, and self-clears via polling when runs finish.
  const qc = useQueryClient();
  const { data: activeRuns } = usePrActiveRuns(prId);
  const { data: prRuns } = usePrRuns(prId);
  const deleteRun = useDeleteRun(prId);
  const liveRunIds = (activeRuns ?? []).map((r) => r.run_id);
  const reviewRunning = liveRunIds.length > 0;
  const cancel = useCancelRun();
  const invalidateActiveRuns = () => {
    if (prId) qc.invalidateQueries({ queryKey: ["pr-active-runs", prId] });
  };
  // When a run settles (done OR failed) refresh the full run history too, so a
  // just-failed run shows up in "Run history" immediately — no page reload.
  const invalidateRunHistory = () => {
    if (prId) qc.invalidateQueries({ queryKey: ["pr-runs", prId] });
  };

  const [tab, setTab] = useQueryParam("tab", "overview");
  const [traceRunId, setTraceRunId] = useQueryParam("trace");
  // Smart Diff → Findings deep-link: ?finding=<id> targets one FindingCard.
  // Both keys must land in ONE URL write (same-tick different-key setters lose
  // the first write — see use-query-param.ts), hence the batched setter.
  const [findingTarget, setFindingTarget] = useQueryParam("finding");
  // Blast card → Files changed deep-link: ?file=<path>&line=<n> targets one
  // FileCard (goToFinding mirror; same batched-write requirement).
  const [fileParam] = useQueryParam("file");
  const [lineParam] = useQueryParam("line");
  const setParams = useSetQueryParams();
  const goToFinding = (id: string) => setParams({ tab: "findings", finding: id });
  const fileTarget = fileParam
    ? { file: fileParam, line: lineParam ? Number(lineParam) : undefined }
    : null;
  const clearFileTarget = () => setParams({ file: null, line: null });

  // Reviews come newest-first; each is its own run (grouped into accordions).
  // Derived during render, not memoized: flattening a handful of reviews is not
  // an expensive computation, and a memo here previously depended on `reviews`
  // while reading `runs` — a stale-value trap the moment the two diverge.
  const runs = reviews ?? [];
  const allFindings: FindingRecord[] = runs.flatMap((r) => r.findings);
  const lethalTrifecta = allFindings.filter((f) => f.kind === "lethal_trifecta");
  const findingsCount = allFindings.length;

  const repoName = repo?.full_name ?? repoId;
  const crumb = [
    { label: repoName, mono: true, href: `/repos/${repoId}/pulls` },
    { label: "Pull Requests", href: `/repos/${repoId}/pulls` },
    { label: `#${number}`, mono: true },
  ];

  // Stale/unknown :repoId → friendly empty state instead of a 404 error.
  if (repoNotFound) {
    return (
      <AppShell crumb={crumb}>
        <RepoNotFound />
      </AppShell>
    );
  }

  if (isLoading) {
    return (
      <AppShell crumb={crumb}>
        <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 16, maxWidth: 1080, margin: "0 auto" }}>
          <Skeleton height={28} width={420} />
          <Skeleton height={16} width={300} />
          <Skeleton height={200} />
        </div>
      </AppShell>
    );
  }

  if (isError || !pr) {
    return (
      <AppShell crumb={crumb}>
        <ErrorState
          fullScreen
          title="Couldn't load this pull request"
          body={error instanceof ApiError ? error.message : `PR #${number} could not be loaded.`}
          onRetry={() => refetch()}
        />
      </AppShell>
    );
  }

  // Blast file:line click: in-app when the file is part of this PR's diff,
  // otherwise a host blob link pinned to the head SHA (new tab). No safe link
  // (unknown repo / rejected host URL) → nothing opens.
  const goToFile = (file: string, line?: number) => {
    const inDiff = pr.files.some((f) => f.path === file);
    if (inDiff) {
      setParams({ tab: "diff", file, line: line != null ? String(line) : null });
      return;
    }
    const href = repo ? hostBlobUrl(repo, pr.head_sha, file, line) : null;
    if (href) window.open(href, "_blank", "noopener,noreferrer");
  };

  return (
    <AppShell crumb={crumb}>
      <PrDetailHeader
        pr={pr}
        prId={prId}
        tab={tab}
        findingsCount={findingsCount}
        hostUrl={repo ? hostPrUrl(repo, pr.number) : null}
        provider={hostLabelKey(repo)}
        onSetTab={setTab}
        onRunStart={() => setTab("findings")}
        onRunsStarted={() => invalidateActiveRuns()}
      />

      <div style={{ padding: "24px 32px 44px", display: "flex", flexDirection: "column", gap: 24, maxWidth: 1080, margin: "0 auto" }}>
        {tab === "overview" && (
          <OverviewTab
            prBody={pr.body}
            prId={prId}
            headSha={pr.head_sha}
            repo={repo}
            onGoToFile={goToFile}
            onGoToFinding={goToFinding}
          />
        )}

        {tab === "findings" && (
          <FindingsTab
            prId={prId}
            liveRunIds={liveRunIds}
            reviewRunning={reviewRunning}
            lethalTrifecta={lethalTrifecta}
            runs={runs}
            prRuns={prRuns}
            prCommits={pr.commits}
            repo={repo}
            readOnly={readOnly}
            headSha={pr.head_sha}
            targetFindingId={findingTarget || null}
            onFindingTargetConsumed={() => setFindingTarget(null)}
            cancelMutation={cancel}
            onOpenTrace={setTraceRunId}
            onDelete={(id) => {
              if (window.confirm("Delete this run from history? (its logs are removed too)"))
                deleteRun.mutate(id);
            }}
            onRunDone={() => {
              invalidateActiveRuns();
              invalidateRunHistory();
              refetchReviews();
              // Smart Diff joins findings onto diff lines — refresh it too.
              if (prId) qc.invalidateQueries({ queryKey: ["pr-smart-diff", prId] });
              // The brief's deterministic rollup and its `stale` flag are computed
              // per read — re-READ it so the flag flips. Never a regeneration (N5).
              if (prId) qc.invalidateQueries({ queryKey: ["pr-brief", prId] });
            }}
          />
        )}

        {tab === "diff" && (
          <DiffTab
            prId={prId}
            filesCount={pr.files_count}
            files={pr.files}
            canComment={pr.status === "open"}
            host={{
              readOnly,
              provider: hostLabelKey(repo),
              filesOmittedByHost: pr.files_omitted_by_host ?? 0,
            }}
            reviews={runs}
            onGoToFinding={goToFinding}
            fileTarget={fileTarget}
            onFileTargetConsumed={clearFileTarget}
          />
        )}
      </div>

      {prId && traceRunId && (
        <RunTraceDrawer
          runId={traceRunId}
          prNumber={pr.number}
          findings={runs.find((r) => r.run_id === traceRunId)?.findings ?? []}
          agentName={runs.find((r) => r.run_id === traceRunId)?.agent_name ?? null}
          onClose={() => setTraceRunId(null)}
        />
      )}
    </AppShell>
  );
}
