/* SmartDiffViewer — risk-ordered "Files changed" view (Smart order). Renders the
   deterministic SmartDiff payload as three role sections (core / wiring /
   boilerplate) of FileCards, joins finding severity per NEW line from the
   already-loaded reviews payload (no extra fetch), and deep-links a finding
   click to the exact FindingCard via the batched ?tab=findings&finding=… write.
   No popups, no GitHub links, no scroll-to-file-top (locked requirements). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon, Badge } from "@devdigest/ui";
import type {
  PrFile,
  ReviewRecord,
  SmartDiffFile,
  SmartDiffGroup,
  SmartDiffResponse,
} from "@devdigest/shared";
import { FileCard, type LineFinding } from "@/components/diff-viewer";
import { GROUP_META, LARGE_FILE_LINES } from "./constants";
import { buildLineFindings, countFindingsPerFile, sumStats } from "./helpers";
import { s, roleSquare, sectionChevron } from "./styles";

/** One SmartDiff file rendered as a FileCard with overlays + badges. */
function SmartFileCard({
  file,
  prFile,
  lineFindings,
  findingsCount,
  onFindingClick,
}: {
  file: SmartDiffFile;
  prFile: PrFile | undefined;
  lineFindings: Map<number, LineFinding> | undefined;
  findingsCount: number;
  onFindingClick?: (findingId: string) => void;
}) {
  const t = useTranslations("prReview");
  const changedLines = file.additions + file.deletions;
  const isLarge = changedLines > LARGE_FILE_LINES;
  const hasFindings = findingsCount > 0;
  return (
    <FileCard
      file={
        prFile ?? {
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
          patch: null,
        }
      }
      defaultOpen={hasFindings}
      lineFindings={lineFindings}
      onFindingClick={onFindingClick}
      highlightLarge={isLarge}
      headerBadge={
        <>
          {isLarge && (
            <span style={s.largeHint}>{t("smartDiff.largeFileHint", { lines: changedLines })}</span>
          )}
          {hasFindings && (
            <Badge color="var(--crit)" bg="var(--crit-bg)" dot>
              {t("smartDiff.fileFindings", { count: findingsCount })}
            </Badge>
          )}
        </>
      }
    />
  );
}

/** One role section: coloured square + label + subtitle + file count, collapsible. */
function GroupSection({
  group,
  fileByPath,
  lineFindings,
  findingCounts,
  onFindingClick,
}: {
  group: SmartDiffGroup;
  fileByPath: Map<string, PrFile>;
  lineFindings: Map<string, Map<number, LineFinding>>;
  findingCounts: Map<string, number>;
  onFindingClick?: (findingId: string) => void;
}) {
  const t = useTranslations("prReview");
  const meta = GROUP_META[group.role];
  // Boilerplate is ALWAYS collapsed by default; Core + Wiring start expanded.
  const [open, setOpen] = React.useState(meta.defaultOpen);
  return (
    <section style={s.section}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setOpen((o) => !o);
        }}
        style={s.sectionHeader}
      >
        <Icon.ChevronRight size={13} style={sectionChevron(open)} />
        <span style={roleSquare(meta.color)} />
        <span style={s.sectionTitle}>{t(`smartDiff.${meta.labelKey}`)}</span>
        <span style={s.sectionSub}>{t(`smartDiff.${meta.subKey}`)}</span>
        <span style={s.sectionCount}>{t("smartDiff.filesCount", { count: group.files.length })}</span>
      </div>
      {open && group.files.length > 0 && (
        <div style={s.filesList}>
          {group.files.map((f) => {
            const count = findingCounts.get(f.path) ?? 0;
            return (
              <SmartFileCard
                // The findings flag is part of the key so a file that gains
                // findings after a run remounts and re-evaluates defaultOpen.
                key={`${f.path}:${count > 0 ? "findings" : "clean"}`}
                file={f}
                prFile={fileByPath.get(f.path)}
                lineFindings={lineFindings.get(f.path)}
                findingsCount={count}
                onFindingClick={onFindingClick}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

export function SmartDiffViewer({
  smartDiff,
  files,
  reviews,
  onFindingClick,
}: {
  smartDiff: SmartDiffResponse;
  /** The PR's files (already loaded on the page) — source of the patch text. */
  files: PrFile[];
  /** The PR's reviews (already loaded on the page) — severity join source. */
  reviews: ReviewRecord[];
  onFindingClick?: (findingId: string) => void;
}) {
  const t = useTranslations("prReview");
  const tShell = useTranslations("shell");

  const stats = sumStats(smartDiff); // cheap derive-in-render, no memo needed
  const lineFindings = React.useMemo(() => buildLineFindings(reviews), [reviews]);
  const findingCounts = React.useMemo(() => countFindingsPerFile(reviews), [reviews]);
  const fileByPath = React.useMemo(
    () => new Map(files.map((f) => [f.path, f])),
    [files],
  );

  if (stats.files === 0) {
    return <div style={s.empty}>{tShell("diffViewer.noChangedFiles")}</div>;
  }

  const { too_big, total_lines, proposed_splits } = smartDiff.split_suggestion;

  return (
    <div style={s.wrap}>
      <div className="mono tnum" style={s.statRow}>
        {t("smartDiff.statLine", {
          count: stats.files,
          additions: stats.additions,
          deletions: stats.deletions,
        })}
      </div>

      {too_big && (
        <div style={s.splitHint}>
          <div style={s.splitTitle}>
            <Icon.AlertTriangle size={14} style={{ color: "var(--warn)", flexShrink: 0 }} />
            {t("smartDiff.largeTitle", { lines: total_lines })}
          </div>
          <div style={s.splitBody}>{t("smartDiff.largeBody")}</div>
          {proposed_splits.length > 0 && (
            <ul style={s.splitList}>
              {proposed_splits.map((split) => (
                <li key={split.name} style={s.splitItem}>
                  <span className="mono" style={s.splitName}>
                    {split.name}
                  </span>
                  <span style={s.splitCount}>
                    {t("smartDiff.filesCount", { count: split.files.length })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {smartDiff.groups.map((group) => (
        <GroupSection
          key={group.role}
          group={group}
          fileByPath={fileByPath}
          lineFindings={lineFindings}
          findingCounts={findingCounts}
          onFindingClick={onFindingClick}
        />
      ))}
    </div>
  );
}

export default SmartDiffViewer;
