/* ProjectContextView — the /repos/:repoId/project-context screen (L05).
   States: skeletons → load error → clone-not-available (AC-5, an empty state,
   NOT an error) → empty → populated (master-detail: left file list with reload,
   right inline Preview/Edit pane + summary footer). The footer deliberately
   avoids any "chunks"/"indexed" wording (AC-7): docs are read fresh from the
   clone on every run, nothing is indexed. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, EmptyState, ErrorState, Icon, IconBtn, Skeleton } from "@devdigest/ui";
import { AppShell } from "@/components/app-shell";
import { useActiveRepo } from "@/lib/repo-context";
import { useProjectContext } from "@/lib/hooks/projectContext";
import { rootDirOf } from "@/lib/root-dir";
import type { DiscoveredDocument } from "@devdigest/shared";
import { BUCKET_BADGE, NEUTRAL_BADGE, SKELETON_ROWS } from "./constants";
import { relativeTime, splitPath } from "./helpers";
import { s } from "./styles";
import { DocumentPane } from "./_components/DocumentPane";

export function ProjectContextView({ repoId }: { repoId: string }) {
  const t = useTranslations("projectContext");
  const { activeRepo } = useActiveRepo();
  const query = useProjectContext(repoId);
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null);

  const repoName = activeRepo?.full_name ?? repoId;
  const documents = query.data?.documents ?? [];
  const summary = query.data?.summary ?? null;
  // Derive the selection: the clicked row if it still exists, else the first
  // document (auto-select on load) — no effect needed.
  const selected = documents.find((d) => d.path === selectedPath) ?? documents[0];

  let content: React.ReactNode;
  if (query.isLoading) {
    content = (
      <div style={s.skeletons}>
        <Skeleton height={28} width={320} />
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <Skeleton key={i} height={48} />
        ))}
      </div>
    );
  } else if (query.isError) {
    content = (
      <div style={s.centered}>
        <ErrorState body={t("page.loadError")} onRetry={() => query.refetch()} />
      </div>
    );
  } else if (summary && !summary.clone_available) {
    // Clone-absent is a normal state, not an error (AC-5).
    content = (
      <div style={s.centered}>
        <EmptyState
          icon="Folder"
          title={t("page.cloneUnavailable.title")}
          body={t("page.cloneUnavailable.body")}
        />
      </div>
    );
  } else if (documents.length === 0) {
    content = (
      <div style={s.centered}>
        <EmptyState icon="FileText" title={t("page.empty.title")} body={t("page.empty.body")} />
      </div>
    );
  } else {
    const ago = summary ? relativeTime(summary.refreshed_at) : null;
    content = (
      <div style={s.inner}>
        <div>
          <h1 style={s.heading}>
            {t("page.title")}
            <span className="mono" style={s.headingRepo}>
              {repoName}
            </span>
          </h1>
          <p style={s.subtitle}>{t("page.subtitle")}</p>
        </div>

        <div style={s.layout}>
          <div style={s.left}>
            <div style={s.leftHeader}>
              <span style={s.caption}>{t("list.caption")}</span>
              <IconBtn
                icon="RefreshCw"
                size={26}
                label={t("list.reload")}
                onClick={() => void query.refetch()}
              />
            </div>
            <ul style={s.fileList}>
              {documents.map((doc) => (
                <FileRow
                  key={doc.path}
                  doc={doc}
                  selected={doc.path === selected?.path}
                  onSelect={() => setSelectedPath(doc.path)}
                />
              ))}
            </ul>
          </div>
          {/* Keyed by path so Preview/Edit mode + draft reset per document. */}
          {selected && <DocumentPane key={selected.path} repoId={repoId} doc={selected} />}
        </div>

        {summary && ago && (
          <div style={s.footer}>
            {t("page.footer", {
              count: summary.document_count,
              tokens: summary.total_estimated_tokens,
              ago: ago.key === "justNow" ? t("time.justNow") : t(`time.${ago.key}`, { count: ago.count }),
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <AppShell crumb={[{ label: repoName, mono: true }, { label: t("page.crumb") }]}>
      <div style={s.page}>{content}</div>
    </AppShell>
  );
}

/** One file-list row: file icon + filename + root-dir badge; keyboard-operable
    (a real button), selected row highlighted + marked with aria-current. */
function FileRow({
  doc,
  selected,
  onSelect,
}: {
  doc: DiscoveredDocument;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useTranslations("projectContext");
  const { name } = splitPath(doc.path);
  // Badge = root directory of the path; bucket only as a root-level fallback.
  const label = rootDirOf(doc.path) ?? doc.bucket ?? "/";
  const tone = BUCKET_BADGE[label] ?? NEUTRAL_BADGE;
  return (
    <li>
      <button
        type="button"
        style={selected ? { ...s.fileBtn, ...s.fileBtnSelected } : s.fileBtn}
        aria-current={selected || undefined}
        aria-label={t("list.openLabel", { path: doc.path })}
        onClick={onSelect}
      >
        <Icon.FileText size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
        <span className="mono" style={s.fileName}>
          {name}
        </span>
        {/* Colour + text label — never colour alone (WCAG 2.1 AA). */}
        <Badge mono color={tone.color} bg={tone.bg} dot>
          {label}
        </Badge>
      </button>
    </li>
  );
}

export default ProjectContextView;
