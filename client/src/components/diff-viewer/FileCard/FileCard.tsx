/* FileCard — one collapsible file in the diff: header (path, +/- stat, comment
   count) and, when open, its parsed lines plus any outdated comments. Smart
   order adds optional finding overlays per NEW line, a header badge, and a
   large-file header tint — all opt-in props; existing callers are unchanged. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import type { PrFileHost } from "@/lib/types";
import { AUTO_EXPAND_MAX_LINES, type LineFinding } from "../constants";
import { parsePatch, type Line } from "../helpers";
import {
  buildThreads,
  keysForLine,
  partitionThreads,
  type CommentThread,
  type DiffCommentApi,
} from "../comments";
import { s, chevronFor, fileHeaderLarge } from "../styles";
import { fc } from "./styles";
import { CodeLine } from "../CodeLine";
import { OutdatedComments } from "../OutdatedComments";

/** Threads anchored to a given parsed line (RIGHT=new, LEFT=old). */
function threadsForLine(ln: Line, matched: Map<string, CommentThread[]>): CommentThread[] {
  if (matched.size === 0) return [];
  const out: CommentThread[] = [];
  for (const key of keysForLine(ln)) {
    const list = matched.get(key);
    if (list) out.push(...list);
  }
  return out;
}

/* Host-only bits read the `prHost` namespace — kept in their own components so
   a plain GitHub file never resolves it (catalog-less callers stay warning-free). */
function RenamedPath({ from, to }: { from: string; to: string }) {
  const t = useTranslations("prHost");
  return <>{t("files.renamed", { from, to })}</>;
}

function OmittedNote({ kind }: { kind: NonNullable<PrFileHost["patch_omitted"]> }) {
  const t = useTranslations("prHost");
  return (
    <div style={s.noDiff}>{t(kind === "collapsed" ? "files.collapsed" : "files.tooLarge")}</div>
  );
}

export function FileCard({
  file,
  commenting,
  defaultOpen,
  lineFindings,
  headerBadge,
  onFindingClick,
  highlightLarge,
}: {
  file: PrFileHost;
  commenting?: DiffCommentApi;
  /** Overrides the auto-expand-by-size initial state (user can still toggle). */
  defaultOpen?: boolean;
  /** Finding overlays keyed by NEW line number (severity join done upstream). */
  lineFindings?: Map<number, LineFinding>;
  /** Extra node(s) rendered in the header (e.g. the "N findings" badge). */
  headerBadge?: React.ReactNode;
  onFindingClick?: (findingId: string) => void;
  /** Tint the header for large files (changed lines above the caller's threshold). */
  highlightLarge?: boolean;
}) {
  const t = useTranslations("shell");
  // A host-omitted patch has nothing to render but its note — open it so the
  // reason is visible without a click.
  const omitted = file.patch_omitted ?? null;
  const renamedFrom =
    file.previous_path && file.previous_path !== file.path ? file.previous_path : null;
  const [open, setOpen] = React.useState(
    defaultOpen ??
      (omitted != null ||
        (file.additions ?? 0) + (file.deletions ?? 0) <= AUTO_EXPAND_MAX_LINES)
  );
  const lines = React.useMemo(() => parsePatch(file.patch), [file.patch]);

  // Group this file's comments into threads, then split into ones we can anchor
  // to a rendered line vs. "outdated" (the host dropped the line / it's not here).
  const comments = commenting?.comments;
  const { matched, outdated } = React.useMemo(() => {
    if (!comments) return { matched: new Map<string, CommentThread[]>(), outdated: [] };
    const fileThreads = buildThreads(comments.filter((c) => c.path === file.path));
    const renderedKeys = new Set<string>();
    for (const ln of lines) for (const k of keysForLine(ln)) renderedKeys.add(k);
    return partitionThreads(fileThreads, renderedKeys);
  }, [comments, file.path, lines]);

  const commentCount = commenting
    ? commenting.comments.filter((c) => c.path === file.path).length
    : 0;

  return (
    // data-file-path: deep-link anchor (DiffTab's fileTarget scroll lookup).
    <div style={s.fileCard} data-file-path={file.path}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={highlightLarge ? { ...s.fileHeader, ...fileHeaderLarge } : s.fileHeader}
      >
        <Icon.ChevronRight size={13} style={chevronFor(open)} />
        <Icon.FileText size={14} style={s.fileIcon} />
        <span className="mono" style={s.filePath}>
          {renamedFrom ? <RenamedPath from={renamedFrom} to={file.path} /> : file.path}
        </span>
        <span className="mono tnum" style={s.fileStat}>
          <span style={s.addText}>+{file.additions}</span>{" "}
          <span style={s.delText}>−{file.deletions}</span>
        </span>
        {commentCount > 0 && (
          <span style={fc.commentCount}>
            <Icon.MessageSquare size={12} />
            {commentCount}
          </span>
        )}
        {headerBadge}
      </div>
      {open && (
        <div style={s.fileBody}>
          {omitted ? (
            <OmittedNote kind={omitted} />
          ) : lines.length === 0 ? (
            <div style={s.noDiff}>{t("diffViewer.noDiffText")}</div>
          ) : (
            lines.map((ln, i) => (
              <CodeLine
                key={i}
                ln={ln}
                path={file.path}
                threads={threadsForLine(ln, matched)}
                commenting={commenting}
                finding={ln.newNo != null ? lineFindings?.get(ln.newNo) : undefined}
                onFindingClick={onFindingClick}
              />
            ))
          )}
          {commenting && commenting.showComments && (
            <OutdatedComments threads={outdated} provider={commenting.provider} />
          )}
        </div>
      )}
    </div>
  );
}
