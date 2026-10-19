/**
 * PR-list read model: the persisted PR rows of a repo + per-PR review rollups
 * (score, findings, cost) for `GET /repos/:id/pulls[/page]`. DB only — never
 * calls the host; the host sync is the `prSync` coordinator's job.
 */
import type { PrMetaHost } from '@devdigest/shared';
import { latestReviewPerAgent, rollupReviews } from '../_shared/review-rollup.js';
import type { PullsReadRepository } from './repository.js';
import { deriveReviewStatus } from './status.js';

/** The read-side queries the list needs (structural — `PullsReadRepository` satisfies it). */
export type PullListReads = Pick<
  PullsReadRepository,
  'listForRepo' | 'listReviewRollupInputs' | 'listFindingSeverities' | 'listRunCosts'
>;

export class PullListService {
  constructor(private reads: PullListReads) {}

  /**
   * The persisted PR list + per-PR review rollups. DB only — no host calls.
   * `is_draft` / `stats_known` are mapped ONLY when non-null, so a GitHub row
   * (where they are never written) keeps the exact pre-GitLab DTO field set (AC-60).
   */
  async list(workspaceId: string, repoId: string): Promise<PrMetaHost[]> {
    const rows = await this.reads.listForRepo({ workspaceId, repoId });

    // SCORE + FINDINGS severity breakdown per PR for the list's score ring and
    // findings column, aggregated across ALL agents that reviewed the PR (a PR is
    // typically reviewed by several agents at once). We take each agent's LATEST
    // review (a re-run replaces its prior review, never double-counts), then:
    //   - FINDINGS = SUM of severities across those per-agent-latest reviews;
    //   - SCORE    = the WORST (lowest) score among them, so one agent's blocker
    //                isn't masked by another agent's clean 100.
    // Computed on read (no FK denorm); the list is small, so IN-queries + JS
    // grouping are cheap.
    const prIds = rows.map((r) => r.id);
    // prId → worst score across agents; null when reviewed but unscored, absent
    // when never reviewed (so the column reads "—").
    const scoreByPr = new Map<string, number | null>();
    // Total review cost per PR = SUM of cost across ALL of the PR's agent runs
    // (every reviewer, not just the latest). null when the PR has no priced run
    // yet, so the column reads "—" rather than "$0.00".
    const costByPr = new Map<string, number | null>();
    // prId → summed { CRITICAL, WARNING, SUGGESTION }; absent PRs read `null`.
    const findingsByPr = new Map<
      string,
      { CRITICAL: number; WARNING: number; SUGGESTION: number }
    >();
    if (prIds.length > 0) {
      // `verdict`/`runId` are unused by the list row (N10 freezes it) but are
      // part of the shared rollup's input shape; `createdAt` is what makes
      // "latest per agent" well-defined.
      const reviewRows = await this.reads.listReviewRollupInputs(workspaceId, prIds);
      // ONE shared implementation of the per-agent-latest rule
      // (`modules/_shared/review-rollup.ts`), so the PR list and the PR brief
      // cannot drift apart. The SQL stays newest-first for the index; the
      // helper's sort is stable, so ties keep this order.
      const latest = latestReviewPerAgent(reviewRows);

      // Findings for exactly those per-agent-latest reviews, keyed by review id.
      // Dismissed findings are NOT excluded — unchanged list behaviour.
      const reviewIds = latest.map((r) => r.id);
      const findingsByReview = new Map<string, { severity: string }[]>();
      if (reviewIds.length > 0) {
        const findingRows = await this.reads.listFindingSeverities(workspaceId, reviewIds);
        for (const fr of findingRows) {
          const arr = findingsByReview.get(fr.reviewId) ?? [];
          arr.push({ severity: fr.severity });
          findingsByReview.set(fr.reviewId, arr);
        }
      }

      // The list shows no blocker count, so the rollup's blocker input is empty.
      const noBlockers = new Map<string, number | null>();
      const latestByPr = new Map<string, typeof latest>();
      for (const rv of latest) {
        const arr = latestByPr.get(rv.prId) ?? [];
        arr.push(rv);
        latestByPr.set(rv.prId, arr);
      }
      // Only PRs that HAVE a review get an entry: `rollupReviews` cannot tell
      // "reviewed but unscored" (score null, findings {0,0,0}) from "never
      // reviewed" (score null, findings null) — that distinction is the caller's,
      // and here it is exactly "is this PR in `latestByPr`".
      for (const [prId, prLatest] of latestByPr) {
        const rollup = rollupReviews(prLatest, findingsByReview, noBlockers);
        scoreByPr.set(prId, rollup.score);
        findingsByPr.set(prId, {
          CRITICAL: rollup.severities.critical,
          WARNING: rollup.severities.warning,
          SUGGESTION: rollup.severities.suggestion,
        });
      }

      const runRows = await this.reads.listRunCosts(workspaceId, prIds);
      for (const rr of runRows) {
        if (rr.costUsd != null) costByPr.set(rr.prId, (costByPr.get(rr.prId) ?? 0) + rr.costUsd);
        else if (!costByPr.has(rr.prId)) costByPr.set(rr.prId, null);
      }
    }

    const now = Date.now();
    return rows.map((r) => {
      return {
        id: r.id,
        number: r.number,
        title: r.title,
        author: r.author,
        branch: r.branch,
        base: r.base,
        head_sha: r.headSha,
        additions: r.additions,
        deletions: r.deletions,
        files_count: r.filesCount,
        status: deriveReviewStatus({
          ghStatus: r.status,
          lastReviewedSha: r.lastReviewedSha,
          headSha: r.headSha,
          updatedAt: r.updatedAt,
          now,
        }),
        opened_at: r.openedAt?.toISOString() ?? null,
        updated_at: r.updatedAt?.toISOString() ?? null,
        score: scoreByPr.get(r.id) ?? null,
        cost_usd: costByPr.get(r.id) ?? null,
        findings: findingsByPr.get(r.id) ?? null,
        ...(r.isDraft != null ? { is_draft: r.isDraft } : {}),
        ...(r.statsKnown != null ? { stats_known: r.statsKnown } : {}),
      };
    });
  }
}
