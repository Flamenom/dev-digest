/* PR list — /repos/:repoId/pulls. Ported from screen_dashboard.jsx; fetches
   GET /repos/:id/pulls (F1). Filter/search/sort ALL live in the URL
   (?status&q&sort) so the view survives reload and is shareable. */
"use client";

import React from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Skeleton,
  EmptyState,
  ErrorState,
  AutoTriggerStatus,
} from "@devdigest/ui";
import { AppShell } from "@/components/app-shell";
import { RepoNotFound } from "@/components/repo-not-found";
import { usePulls, useRefreshRepo, useQueryParam, useDebouncedQueryParam } from "@/lib/hooks";
import { useActiveRepo, useRepoNotFound } from "@/lib/repo-context";
import { ApiError } from "@/lib/api";
import { COLUMN_KEYS, SKELETON_ROWS } from "./constants";
import { filterAndSortPulls, countPulls } from "./helpers";
import { s } from "./styles";
import { PRRow } from "./_components/PRRow";
import { FilterBar } from "./_components/FilterBar";

export default function PullsPage() {
  const t = useTranslations("prReview");
  const params = useParams<{ repoId: string }>();
  const repoId = params.repoId;
  const { activeRepo } = useActiveRepo();
  const repoNotFound = useRepoNotFound(repoId);
  const { data: pulls, isLoading, isError, error, refetch } = usePulls(repoId);
  const refresh = useRefreshRepo();

  // Default to "needs review" — the most actionable filter on open. Note:
  // useQueryParam drops the key when set to the empty string, so "all" (a
  // non-empty value) sticks in the URL over the needs_review default.
  const [status, setStatus] = useQueryParam("status", "needs_review");
  const [query, setQuery] = useDebouncedQueryParam("q");
  const [sort, setSort] = useQueryParam("sort", "newest");

  const filtered = filterAndSortPulls(pulls ?? [], { status, query, sort });
  const { open: openCount, needsReview: needsReviewCount } = countPulls(pulls ?? []);
  const repoName = activeRepo?.full_name ?? repoId;

  // Stale/unknown :repoId → friendly empty state instead of a 404 error.
  if (repoNotFound) {
    return (
      <AppShell crumb={[{ label: repoName, mono: true }, { label: t("list.breadcrumb") }]}>
        <RepoNotFound />
      </AppShell>
    );
  }

  return (
    <AppShell crumb={[{ label: repoName, mono: true }, { label: t("list.breadcrumb") }]}>
      <div style={s.pageHeader}>
        <div>
          <h1 style={s.pageTitle}>{t("list.title")}</h1>
          <p style={s.pageSubtitle}>
            {pulls
              ? t("list.summary", { open: openCount, needsReview: needsReviewCount })
              : t("list.loading")}
          </p>
        </div>
        <div style={s.headerActions}>
          <AutoTriggerStatus on={false} />
        </div>
      </div>

      <div style={s.tableCard}>
        <FilterBar
          active={status}
          onActive={setStatus}
          query={query}
          onQuery={setQuery}
          sort={sort}
          onSort={setSort}
          onRefresh={() => refresh.mutate(repoId)}
          refreshing={refresh.isPending}
        />
        <div style={s.headRow}>
          {COLUMN_KEYS.map((key, i) => (
            <div key={key} style={s.headCell(i === COLUMN_KEYS.length - 1)}>
              {t(`list.columns.${key}`)}
            </div>
          ))}
        </div>

        {isLoading ? (
          <div style={s.loadingStack}>
            {Array.from({ length: SKELETON_ROWS }).map((_, i) => (
              <Skeleton key={i} height={28} />
            ))}
          </div>
        ) : isError ? (
          <ErrorState
            title={t("list.errorTitle")}
            body={error instanceof ApiError ? error.message : t("list.errorBody")}
            onRetry={() => refetch()}
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon="GitPullRequest"
            title={t("list.emptyTitle")}
            body={
              status === "all"
                ? t("list.emptyAllBody")
                : t("list.emptyStatusBody", { status })
            }
          />
        ) : (
          filtered.map((pr) => <PRRow key={pr.number} pr={pr} repoId={repoId} />)
        )}
      </div>
    </AppShell>
  );
}
