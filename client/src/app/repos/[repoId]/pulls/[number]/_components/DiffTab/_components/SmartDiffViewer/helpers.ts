/** Pure helpers for the SmartDiffViewer — the client-side severity join.
 *  Replicates the server's documented rule (latest review per (prId, agentId),
 *  kind='review', non-dismissed findings) over the ALREADY-LOADED usePrReviews
 *  payload, so no extra fetch and no new contract fields are needed. */
import type { ReviewRecord, SmartDiff } from "@devdigest/shared";
import type { LineFinding } from "@/components/diff-viewer";
import { FINDING_LINE_SPAN_CAP, SEVERITY_RANK } from "./constants";

/** Newest review per agent (kind='review', newest-first first-seen per agent). */
export function latestReviewsPerAgent(reviews: ReviewRecord[]): ReviewRecord[] {
  const sorted = reviews
    .filter((r) => r.kind === "review")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const seen = new Set<string>();
  const out: ReviewRecord[] = [];
  for (const r of sorted) {
    // Agent-less reviews each count as their own "agent" (keyed by review id) —
    // same rule as the server's latest-per-(prId, agentId) selection.
    const key = r.agent_id ?? r.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Per-file, per-NEW-line finding overlays: Map<path, Map<newLineNo, LineFinding>>.
 * Keeps the WORST severity per line (CRITICAL > WARNING > SUGGESTION), excludes
 * dismissed findings, and caps each finding's span at FINDING_LINE_SPAN_CAP.
 */
export function buildLineFindings(
  reviews: ReviewRecord[],
): Map<string, Map<number, LineFinding>> {
  const out = new Map<string, Map<number, LineFinding>>();
  for (const review of latestReviewsPerAgent(reviews)) {
    for (const f of review.findings) {
      if (f.dismissed_at) continue;
      if (!f.start_line || f.start_line < 1) continue; // nothing to anchor
      const end = Math.min(
        Math.max(f.end_line ?? f.start_line, f.start_line),
        f.start_line + FINDING_LINE_SPAN_CAP - 1,
      );
      let byLine = out.get(f.file);
      if (!byLine) {
        byLine = new Map<number, LineFinding>();
        out.set(f.file, byLine);
      }
      for (let line = f.start_line; line <= end; line++) {
        const existing = byLine.get(line);
        if (
          !existing ||
          (SEVERITY_RANK[f.severity] ?? 9) < (SEVERITY_RANK[existing.severity] ?? 9)
        ) {
          byLine.set(line, { severity: f.severity, findingId: f.id });
        }
      }
    }
  }
  return out;
}

/** Non-dismissed finding count per file (drives the "N findings" badge). */
export function countFindingsPerFile(reviews: ReviewRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const review of latestReviewsPerAgent(reviews)) {
    for (const f of review.findings) {
      if (f.dismissed_at) continue;
      out.set(f.file, (out.get(f.file) ?? 0) + 1);
    }
  }
  return out;
}

/** Files-affected summary for the header row ("N files +A −D"). */
export function sumStats(smartDiff: SmartDiff): {
  files: number;
  additions: number;
  deletions: number;
} {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const group of smartDiff.groups) {
    for (const f of group.files) {
      files++;
      additions += f.additions;
      deletions += f.deletions;
    }
  }
  return { files, additions, deletions };
}
