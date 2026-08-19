/* ConventionsView — the /conventions screen. Repo-scoped via the active-repo
   context. States: no-repo → skeletons → load error → empty (Run extraction
   CTA) → populated (scan meta, Deselect all, accepted count, Re-scan, Create
   skill, candidate cards). Extraction is a synchronous mutation — its
   isPending drives the "Scanning…" affordances. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, EmptyState, ErrorState, Skeleton } from "@devdigest/ui";
import { useActiveRepo } from "@/lib/repo-context";
import { useBulkConventionStatus, useConventions, useExtractConventions } from "@/lib/hooks/conventions";
import { useToast } from "@/lib/toast";
import { AppShell } from "@/components/app-shell";
import { ConventionCard } from "./_components/ConventionCard";
import { CreateSkillModal } from "./_components/CreateSkillModal";
import { relativeTime } from "./helpers";
import { s } from "./styles";

export function ConventionsView() {
  const t = useTranslations("conventions");
  const toast = useToast();
  const { repoId, activeRepo, reposLoaded } = useActiveRepo();
  const query = useConventions(repoId);
  const extract = useExtractConventions(repoId);
  const bulk = useBulkConventionStatus(repoId);
  const [modalOpen, setModalOpen] = React.useState(false);

  const repoName = activeRepo?.full_name ?? t("page.repoFallback");
  const conventions = query.data?.conventions ?? [];
  const stats = query.data?.stats ?? null;
  const accepted = conventions.filter((c) => c.status === "accepted");

  const runExtraction = () => {
    extract.mutate(undefined, {
      onError: () => toast.error(t("page.extractionFailed")),
    });
  };

  const crumb = [{ label: t("page.crumbLab") }, { label: t("page.crumbConventions"), href: "/conventions" }];

  let content: React.ReactNode;
  if (reposLoaded && !repoId) {
    content = (
      <div style={s.centered}>
        <EmptyState icon="ListChecks" title={t("page.noRepo")} />
      </div>
    );
  } else if (query.isLoading || !reposLoaded) {
    content = (
      <div style={s.skeletons}>
        <Skeleton height={28} width={320} />
        <Skeleton height={140} />
        <Skeleton height={140} />
        <Skeleton height={140} />
      </div>
    );
  } else if (query.isError) {
    content = (
      <div style={s.centered}>
        <ErrorState body={t("page.loadError")} onRetry={() => query.refetch()} />
      </div>
    );
  } else if (conventions.length === 0) {
    content = (
      <div style={s.centered}>
        <EmptyState
          icon="ListChecks"
          title={t("page.empty.title")}
          body={t("page.empty.body")}
          cta={extract.isPending ? t("page.scanning") : t("page.empty.cta")}
          onCta={runExtraction}
          ctaLoading={extract.isPending}
        />
      </div>
    );
  } else {
    content = (
      <div style={s.inner}>
        <div style={s.headerRow}>
          <div>
            <h1 style={s.heading}>
              {t("page.headingPrefix")}
              <span className="mono" style={s.headingRepo}>
                {repoName}
              </span>
            </h1>
            <div style={s.metaLine}>
              {stats && (
                <span>
                  {t("page.detectedFrom", {
                    count: stats.sampledFileCount,
                    ago: relativeTime(stats.lastScanAt),
                  })}
                </span>
              )}
              {stats && stats.droppedCount > 0 && (
                <span style={s.droppedNote}>{t("page.droppedNote", { count: stats.droppedCount })}</span>
              )}
            </div>
          </div>
          <Button kind="secondary" icon="RefreshCw" loading={extract.isPending} onClick={runExtraction}>
            {extract.isPending ? t("page.scanning") : t("page.rescan")}
          </Button>
        </div>

        <div style={s.toolbar}>
          <Button
            kind="tertiary"
            icon="X"
            disabled={accepted.length === 0 || bulk.isPending}
            onClick={() => bulk.mutate("pending")}
          >
            {t("page.deselectAll")}
          </Button>
          <span style={s.acceptedCount}>
            {t("page.acceptedCount", { accepted: accepted.length, total: conventions.length })}
          </span>
          <div style={s.toolbarSpacer} />
          <Button
            kind="primary"
            icon="Sparkles"
            disabled={accepted.length === 0}
            onClick={() => setModalOpen(true)}
          >
            {t("page.createSkill")}
          </Button>
        </div>

        <div style={s.list}>
          {conventions.map((c) => (
            <ConventionCard key={c.id} convention={c} repoId={repoId} />
          ))}
        </div>

        {modalOpen && activeRepo && (
          <CreateSkillModal
            repoFullName={activeRepo.full_name}
            accepted={accepted}
            onClose={() => setModalOpen(false)}
          />
        )}
      </div>
    );
  }

  return (
    <AppShell crumb={crumb}>
      <div style={s.page}>{content}</div>
    </AppShell>
  );
}

export default ConventionsView;
