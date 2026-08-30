/* Pure helpers for PrBriefCard — no React, no I/O. */
import type { IconName } from "@devdigest/ui";
import type { BriefStatus, FindingRecord, ReviewRecord } from "@devdigest/shared";
import { VERDICT_META } from "../../../VerdictBanner/constants";
import { NOT_REVIEWED_META } from "./constants";

/** Icon + colours for the header status square (AC-15, AC-18). */
export function statusMeta(status: BriefStatus): { c: string; bg: string; icon: IconName } {
  if (status === "not_reviewed") return NOT_REVIEWED_META;
  return VERDICT_META[status] ?? VERDICT_META.comment;
}

/**
 * Findings behind the header badge: every finding of every agent's LATEST
 * review, which is exactly the set the server's deterministic rollup counts
 * (AC-17), so the panel can never list more or fewer than the badge claims.
 * Mirrors the PR-list cell rollup (`pulls/_components/PRRow/PRRow.tsx`).
 */
export function latestPerAgentFindings(reviews: ReviewRecord[] | undefined): FindingRecord[] {
  const revs = (reviews ?? []).filter((r) => r.kind === "review");
  const latestPerAgent = new Map<string, ReviewRecord>();
  for (const rev of revs) {
    const key = rev.agent_id ?? rev.id;
    const cur = latestPerAgent.get(key);
    // ISO timestamps compare lexicographically → newest wins.
    if (!cur || rev.created_at > cur.created_at) latestPerAgent.set(key, rev);
  }
  return [...latestPerAgent.values()].flatMap((r) => r.findings);
}
