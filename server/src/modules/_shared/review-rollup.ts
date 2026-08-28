import type { Verdict } from '@devdigest/shared';

/**
 * The per-agent-latest review rollup — ONE implementation, shared by every
 * consumer (PR list, PR brief, …) so the numbers they show cannot drift apart.
 *
 * Why this rule exists (server/INSIGHTS.md, Decisions 2026-08-01): a PR is
 * typically reviewed by SEVERAL agents at once, so multiple `reviews` rows share
 * the same `createdAt`. "The latest review" (`ORDER BY created_at DESC LIMIT 1`)
 * therefore picks an ARBITRARY agent — the symptom was a PR listed as score 100 /
 * 0 findings while another agent had a blocker. The rule is instead:
 *
 *   1. take each agent's LATEST review — a re-run REPLACES that agent's earlier
 *      review and never double-counts;
 *   2. SCORE   = the WORST (lowest) non-null score across those reviews, so one
 *      agent's blocker is not masked by another agent's clean 100. A null score
 *      never overrides a number;
 *   3. VERDICT = the WORST across those reviews (request_changes > comment > approve);
 *   4. FINDINGS = the SUM of severities across those reviews;
 *   5. BLOCKERS = the SUM of `agent_runs.blockers` for the runs those reviews came
 *      from, joined via the nullable `reviews.run_id`. A review with a null
 *      `run_id` (e.g. everything written by `pnpm db:seed`) or a run that is
 *      missing / has a null `blockers` contributes 0 — the rollup never claims a
 *      blocker it cannot evidence.
 *
 * Everything here is PURE: plain structural input shapes (never a Drizzle
 * `$inferSelect` row type), no Drizzle, no Fastify, no I/O. Rows are mapped to
 * these shapes at the repository boundary. `_shared` is the one slice every
 * module may import.
 *
 * CALLER CONTRACT: pass only `kind = 'review'` rows. `'summary'` rows must be
 * filtered out by the caller's query (`where kind = 'review'`) — they are not
 * agent verdicts and would corrupt the rollup.
 */

/** Tally of finding severities, matching the PR list's breakdown columns. */
export interface SeverityCounts {
  critical: number;
  warning: number;
  suggestion: number;
}

/**
 * The fields of a `reviews` row the rollup actually reads. Structural on
 * purpose: callers may pass wider objects (the generic on
 * {@link latestReviewPerAgent} preserves them).
 */
export interface ReviewRollupInput {
  /** `reviews.id` — also the grouping key for agent-less reviews. */
  id: string;
  prId: string;
  /** Nullable in the DB; an agent-less review keys on its own `id`. */
  agentId: string | null;
  score: number | null;
  /** DB column is free-text; unrecognised values are ignored by the rollup. */
  verdict: string | null;
  /** Nullable with no FK — see the blockers rule above. */
  runId: string | null;
  createdAt: Date;
}

/** What a PR's reviews add up to. */
export interface ReviewRollup {
  /** Worst (lowest) non-null score; null when no reviewed agent produced one. */
  score: number | null;
  /** Worst verdict; null when no review carried a recognised verdict. */
  verdict: Verdict | null;
  /** Total findings across the per-agent-latest reviews. */
  findingsCount: number;
  /** Sum of `agent_runs.blockers` over the DISTINCT runs behind those reviews. */
  blockers: number;
  severities: SeverityCounts;
}

/** Worst-first ordering. Higher rank wins; keys are exhaustive over `Verdict`. */
const VERDICT_RANK: Record<Verdict, number> = {
  request_changes: 3,
  comment: 2,
  approve: 1,
};

function verdictRank(verdict: string | null): number | null {
  if (verdict == null) return null;
  return VERDICT_RANK[verdict as Verdict] ?? null;
}

/**
 * Each agent's latest review, across any number of PRs.
 *
 * Rows are sorted newest-first here rather than trusting the caller's
 * `ORDER BY created_at DESC` (the sort is stable, so rows sharing one
 * `createdAt` — the normal case for a multi-agent review — keep their incoming
 * order). First-seen per `(prId, agentId ?? id)` then wins: an agent's re-run
 * replaces its earlier review, and agent-less reviews each count exactly once
 * because they key on their own id.
 *
 * Generic so callers keep any extra fields they carried in.
 */
export function latestReviewPerAgent<T extends ReviewRollupInput>(rows: readonly T[]): T[] {
  const newestFirst = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const seen = new Set<string>();
  const latest: T[] = [];
  for (const row of newestFirst) {
    const key = `${row.prId}:${row.agentId ?? row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    latest.push(row);
  }
  return latest;
}

/**
 * Roll up ONE PR's per-agent-latest reviews (the output of
 * {@link latestReviewPerAgent}, filtered to that PR) into the numbers a card or
 * list row shows.
 *
 * @param latest           per-agent-latest reviews for a single PR.
 * @param findingsByReview `reviews.id` → that review's findings. A review absent
 *                         from the map contributes no findings. Dismissed
 *                         findings are NOT filtered here — pass a pre-filtered
 *                         list if a consumer needs that.
 * @param blockersByRun    `agent_runs.id` → `agent_runs.blockers` (nullable).
 *                         A missing or null entry contributes 0.
 *
 * Empty input → `{ score: null, verdict: null, findingsCount: 0, blockers: 0 }`.
 * "Never reviewed" vs "reviewed but unscored" is the CALLER's distinction: both
 * give `score: null`, and only the caller knows whether `latest` was empty.
 */
export function rollupReviews(
  latest: readonly ReviewRollupInput[],
  findingsByReview: ReadonlyMap<string, readonly { severity: string }[]>,
  blockersByRun: ReadonlyMap<string, number | null>,
): ReviewRollup {
  let score: number | null = null;
  let bestRank: number | null = null;
  let verdict: Verdict | null = null;
  let findingsCount = 0;
  const severities: SeverityCounts = { critical: 0, warning: 0, suggestion: 0 };
  // A run produces one review, but dedupe anyway: `blockers` is a per-RUN count,
  // so a run must never be added twice.
  const countedRuns = new Set<string>();
  let blockers = 0;

  for (const review of latest) {
    // Worst (lowest) score; a null score never overrides a number.
    if (review.score != null) score = score == null ? review.score : Math.min(score, review.score);

    const rank = verdictRank(review.verdict);
    if (rank != null && (bestRank == null || rank > bestRank)) {
      bestRank = rank;
      verdict = review.verdict as Verdict;
    }

    for (const finding of findingsByReview.get(review.id) ?? []) {
      findingsCount += 1;
      if (finding.severity === 'CRITICAL') severities.critical += 1;
      else if (finding.severity === 'WARNING') severities.warning += 1;
      else if (finding.severity === 'SUGGESTION') severities.suggestion += 1;
    }

    if (review.runId != null && !countedRuns.has(review.runId)) {
      countedRuns.add(review.runId);
      blockers += blockersByRun.get(review.runId) ?? 0;
    }
  }

  return { score, verdict, findingsCount, blockers, severities };
}
