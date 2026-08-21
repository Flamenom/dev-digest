/** Constants for the DiffViewer. */

/** Files with this many or fewer changed lines start expanded. */
export const AUTO_EXPAND_MAX_LINES = 200;

/** Matches a unified-diff hunk header, e.g. `@@ -1,2 +1,3 @@`. */
export const HUNK_HEADER_RE = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A finding overlay anchored to a NEW-file line (severity join done by callers). */
export interface LineFinding {
  severity: string;
  findingId: string;
}

/** Severity → line-overlay colour tokens (same palette as FindingCard's SEV_COLOR). */
export const SEV_LINE_COLOR: Record<string, { color: string; bg: string }> = {
  CRITICAL: { color: "var(--crit)", bg: "var(--crit-bg)" },
  WARNING: { color: "var(--warn)", bg: "var(--warn-bg)" },
  SUGGESTION: { color: "var(--sugg)", bg: "var(--sugg-bg)" },
};

/** Fallback overlay colours for an unknown severity. */
export const SEV_LINE_COLOR_FALLBACK = { color: "var(--info)", bg: "var(--info-bg)" };
