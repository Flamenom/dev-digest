/* helpers.ts — pure functions behind the publish-findings UI (AC-36 – AC-39;
   outdated runs: spec 2026-10-23-gitlab-publish-outdated-findings, AC-19 – AC-24).
   No React, no I/O. */
import { PublishErrorCode } from "@devdigest/shared";
import type { Severity } from "@devdigest/shared";
import type {
  PublishBlocker,
  PublishDeprecation,
  PublishPreviewFindingWithDeprecation,
} from "@/lib/types";
import { SEVERITY_ORDER } from "./constants";

/** The publish's "confirm as deprecated" 409 codes (AC-4, AC-23) — owned by the data layer. */
export { DEPRECATION_409_CODES } from "@/lib/hooks/publish";

/** A preview entry; its anchor may be `deferred` (placement decided at publish, AC-19). */
type PublishPreviewFinding = PublishPreviewFindingWithDeprecation;

/** A full lowercase-hex commit SHA (7–64 chars), the same rule as the server's deprecated line (Q6). */
const HEX_SHA = /^[0-9a-f]{7,64}$/;

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

/**
 * The first 8 characters of a lowercase-hex SHA, or null when the value is
 * missing or not hex (then the UI uses the `head_unknown` wording, Q6).
 */
export function shortSha(sha: string | null | undefined): string | null {
  return sha && HEX_SHA.test(sha) ? sha.slice(0, 8) : null;
}

/** The preview's review-level deprecation, or null (not deprecated / not loaded) (AC-1, AC-20). */
export function previewDeprecation(
  preview: { deprecation?: PublishDeprecation | null } | null | undefined,
): PublishDeprecation | null {
  return preview?.deprecation ?? null;
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
  /** Anchors whose placement is decided at publish — neither positioned nor general (AC-19). */
  deferred: number;
  suggestionEligible: number;
}

/** Per-severity, general, deferred and suggestion-eligible counts (AC-38, AC-19). */
export function summarizeSelection(selected: readonly SelectedFinding[]): SelectionSummary {
  const bySeverity = { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 };
  let general = 0;
  let deferred = 0;
  let suggestionEligible = 0;
  for (const { entry, severity } of selected) {
    if ((SEVERITY_ORDER as readonly string[]).includes(severity)) {
      bySeverity[severity as keyof typeof bySeverity] += 1;
    }
    if (entry.anchor.kind === "general") general += 1;
    else if (entry.anchor.kind === "deferred") deferred += 1;
    if (entry.suggestion_eligible) suggestionEligible += 1;
  }
  return { bySeverity, general, deferred, suggestionEligible };
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
