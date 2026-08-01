import type { Finding, Severity } from "@devdigest/shared";

/** Per-severity finding counts (uppercase keys mirror the `Severity` enum). */
export interface SeverityCounts {
  CRITICAL: number;
  WARNING: number;
  SUGGESTION: number;
}

/** Display order for chips + hover-card rows (most severe first). */
export const SEVERITY_SEQUENCE: Severity[] = ["CRITICAL", "WARNING", "SUGGESTION"];

/** Sort weight per severity (lower = shown first); unknown severities sort last. */
export const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 0,
  WARNING: 1,
  SUGGESTION: 2,
};

/** Tally a findings array into per-severity counts. */
export function countBySeverity(findings: Pick<Finding, "severity">[]): SeverityCounts {
  const c: SeverityCounts = { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 };
  for (const f of findings) {
    if (f.severity === "CRITICAL") c.CRITICAL += 1;
    else if (f.severity === "WARNING") c.WARNING += 1;
    else if (f.severity === "SUGGESTION") c.SUGGESTION += 1;
  }
  return c;
}

/** Total findings across severities. */
export function totalCount(c: SeverityCounts): number {
  return c.CRITICAL + c.WARNING + c.SUGGESTION;
}
