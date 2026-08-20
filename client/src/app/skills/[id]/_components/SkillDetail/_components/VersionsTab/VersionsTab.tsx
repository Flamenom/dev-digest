/* VersionsTab — version history, newest first: v{n} badge, note (fallback
   "Body updated"), date, Current chip on the head. Diff opens a client-side
   line diff vs the previous version; Restore calls POST /skills/:id/restore —
   the server re-applies the snapshot body as the new head version with a
   "Restored from v{n}" note. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Card, ErrorState, Skeleton } from "@devdigest/ui";
import type { Skill, SkillVersionEntry } from "@devdigest/shared";
import { useRestoreSkillVersion, useSkillVersions } from "@/lib/hooks/skills";
import { useToast } from "@/lib/toast";
import { formatVersionDate } from "../../helpers";
import { DiffModal } from "./_components/DiffModal";
import { s } from "./styles";

export function VersionsTab({ skill }: { skill: Skill }) {
  const t = useTranslations("skills");
  const toast = useToast();
  const { data: versions, isLoading, isError, refetch } = useSkillVersions(skill.id);
  const restoreVersion = useRestoreSkillVersion();
  const [diffOf, setDiffOf] = React.useState<number | null>(null);

  const sorted = React.useMemo(
    () => [...(versions ?? [])].sort((a, b) => b.version - a.version),
    [versions],
  );
  const head = sorted[0]?.version;

  const restore = (entry: SkillVersionEntry) => {
    if (!window.confirm(t("versions.restoreConfirm", { version: entry.version }))) return;
    restoreVersion.mutate(
      { id: skill.id, version: entry.version },
      { onSuccess: () => toast.success(t("versions.restoredToast", { version: entry.version })) },
    );
  };

  if (isLoading) {
    return (
      <div style={s.wrap}>
        <Skeleton height={56} />
      </div>
    );
  }
  if (isError) return <ErrorState body={t("versions.loadError")} onRetry={() => refetch()} />;

  const diffIdx = diffOf != null ? sorted.findIndex((e) => e.version === diffOf) : -1;
  const diffEntry = diffIdx >= 0 ? sorted[diffIdx] : null;
  const diffPrev = diffIdx >= 0 ? sorted[diffIdx + 1] : null;

  return (
    <div style={s.wrap}>
      {diffEntry && diffPrev && (
        <DiffModal from={diffPrev} to={diffEntry} onClose={() => setDiffOf(null)} />
      )}
      <div style={s.caption}>{t("versions.caption")}</div>
      <Card pad={false}>
        {sorted.length === 0 && <div style={s.empty}>{t("versions.empty")}</div>}
        {sorted.map((entry, idx) => (
          <div key={entry.version} style={s.row}>
            <Badge mono color="var(--accent-text)" bg="var(--accent-bg)">
              {t("versions.version", { version: entry.version })}
            </Badge>
            <span style={s.note}>{entry.note || t("versions.fallbackNote")}</span>
            {entry.version === head && (
              <Badge color="var(--ok)" bg="var(--ok-bg)">
                {t("versions.current")}
              </Badge>
            )}
            <span className="tnum" style={s.date}>
              {formatVersionDate(entry.created_at)}
            </span>
            <Button
              kind="tertiary"
              size="sm"
              icon="GitCommit"
              disabled={idx === sorted.length - 1}
              onClick={() => setDiffOf(entry.version)}
            >
              {t("versions.diff")}
            </Button>
            <Button
              kind="tertiary"
              size="sm"
              icon="History"
              disabled={entry.version === head || restoreVersion.isPending}
              onClick={() => restore(entry)}
            >
              {t("versions.restore")}
            </Button>
          </div>
        ))}
      </Card>
    </div>
  );
}
