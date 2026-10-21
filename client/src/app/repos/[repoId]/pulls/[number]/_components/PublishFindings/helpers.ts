/* helpers.ts — pure functions behind the publish-findings UI (AC-36 – AC-39).
   No React, no I/O. */
import { PublishErrorCode } from "@devdigest/shared";
import type { Severity } from "@devdigest/shared";
import type { PublishBlocker, PublishPreviewFinding } from "@/lib/types";
import { SEVERITY_ORDER } from "./constants";

/** Tri-state of the "Select all publishable" control. */
export type SelectionState = "none" | "some" | "all";

/** A selected preview entry joined with its finding's severity (dialog counts). */
export interface SelectedFinding {
  entry: PublishPreviewFinding;
  severity: Severity;
}

/**
 * True only for an absolute `http:` / `https:` URL. Server URLs are validated
 * again client-side before they reach an `href` (no `javascript:`, `data:`, …).
 */
export function isSafeHttpUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/** `path:start–end` (or `path:line` for a single line). */
export function anchorLocation(anchor: Pick<PublishPreviewFinding["anchor"], "path" | "start_line" | "end_line">): string {
  const { path, start_line, end_line } = anchor;
  return start_line === end_line ? `${path}:${start_line}` : `${path}:${start_line}–${end_line}`;
}

/** Locale date-time of an ISO timestamp; the raw string when unparseable. */
export function formatPublishedAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Tri-state from the selected and publishable counts. */
export function selectionState(selected: number, publishable: number): SelectionState {
  if (selected === 0 || publishable === 0) return "none";
  return selected >= publishable ? "all" : "some";
}

/** `aria-checked` value of a tri-state checkbox. */
export function ariaChecked(state: SelectionState): boolean | "mixed" {
  return state === "some" ? "mixed" : state === "all";
}

/** The one blocker the accordion shows (the server orders them by precedence). */
export function primaryBlocker(blockers: readonly PublishBlocker[] | null | undefined): PublishBlocker | null {
  return blockers?.[0] ?? null;
}

/** Stable, per-review id of the blocker notice (`aria-describedby` target). */
export function publishBlockerNoticeId(reviewId: string): string {
  return `publish-blocker-${reviewId}`;
}

/**
 * Join the selected ids (in preview order) with their findings' severities.
 * Ids without a known finding are dropped.
 */
export function selectedFindings(
  previewFindings: readonly PublishPreviewFinding[],
  selectedIds: ReadonlySet<string>,
  findings: ReadonlyArray<{ id: string; severity: Severity }>,
): SelectedFinding[] {
  const severityById = new Map(findings.map((f) => [f.id, f.severity] as const));
  const out: SelectedFinding[] = [];
  for (const entry of previewFindings) {
    if (!selectedIds.has(entry.finding_id)) continue;
    const severity = severityById.get(entry.finding_id);
    if (severity) out.push({ entry, severity });
  }
  return out;
}

export interface SelectionSummary {
  bySeverity: Record<"CRITICAL" | "WARNING" | "SUGGESTION", number>;
  general: number;
  suggestionEligible: number;
}

/** Per-severity counts, general-comment count and suggestion-eligible count (AC-38). */
export function summarizeSelection(selected: readonly SelectedFinding[]): SelectionSummary {
  const bySeverity = { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 };
  let general = 0;
  let suggestionEligible = 0;
  for (const { entry, severity } of selected) {
    if ((SEVERITY_ORDER as readonly string[]).includes(severity)) {
      bySeverity[severity as keyof typeof bySeverity] += 1;
    }
    if (entry.anchor.kind === "general") general += 1;
    if (entry.suggestion_eligible) suggestionEligible += 1;
  }
  return { bySeverity, general, suggestionEligible };
}

/** Narrows a wire error code to a known publish error code (message-table key). */
export function knownPublishCode(code: string | null | undefined): PublishErrorCode | null {
  const parsed = PublishErrorCode.safeParse(code);
  return parsed.success ? parsed.data : null;
}

/** Progress counter `k` of "Publishing k of N…": processed findings, capped at N. */
export function progressDone(p: { drafted: number; failed: number; requested: number }): number {
  return Math.min(p.drafted + p.failed, p.requested);
}
