/**
 * The shared per-agent-latest review rollup (`modules/_shared/review-rollup.ts`)
 * — the single rule behind the PR list's score/findings columns and the PR
 * brief's gauge, so the two cannot drift apart. Pure functions over plain
 * shapes: no DB, no fastify, no Docker (pulls-status.test.ts style).
 */
import { describe, it, expect } from 'vitest';
import {
  latestReviewPerAgent,
  rollupReviews,
  type ReviewRollupInput,
} from '../src/modules/_shared/review-rollup.js';

const T0 = new Date('2026-08-27T10:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const review = (over: Partial<ReviewRollupInput> & { id: string }): ReviewRollupInput => ({
  prId: 'pr-1',
  agentId: null,
  score: null,
  verdict: null,
  runId: null,
  createdAt: T0,
  ...over,
});

const findings = (severities: string[]) => severities.map((severity) => ({ severity }));

describe('latestReviewPerAgent', () => {
  it("keeps each agent's newest review and drops the superseded re-run", () => {
    const rows = [
      review({ id: 'r-old', agentId: 'a-1', score: 40, createdAt: at(0) }),
      review({ id: 'r-new', agentId: 'a-1', score: 90, createdAt: at(30) }),
      review({ id: 'r-b', agentId: 'a-2', score: 70, createdAt: at(10) }),
    ];

    expect(latestReviewPerAgent(rows).map((r) => r.id).sort()).toEqual(['r-b', 'r-new']);
  });

  it('drops no agent when several reviews share one createdAt', () => {
    // The multi-agent case from server/INSIGHTS.md: identical timestamps must not
    // collapse to one arbitrary agent.
    const rows = [
      review({ id: 'r-1', agentId: 'a-1', createdAt: T0 }),
      review({ id: 'r-2', agentId: 'a-2', createdAt: T0 }),
      review({ id: 'r-3', agentId: 'a-3', createdAt: T0 }),
    ];

    expect(latestReviewPerAgent(rows)).toHaveLength(3);
  });

  it('counts each agent-less review once, keyed on its own id', () => {
    const rows = [
      review({ id: 'r-1', agentId: null, createdAt: T0 }),
      review({ id: 'r-2', agentId: null, createdAt: T0 }),
    ];

    expect(latestReviewPerAgent(rows).map((r) => r.id).sort()).toEqual(['r-1', 'r-2']);
  });

  it('groups per PR, not globally, and sorts unordered input itself', () => {
    const rows = [
      review({ id: 'p1-old', prId: 'pr-1', agentId: 'a-1', createdAt: at(0) }),
      review({ id: 'p2', prId: 'pr-2', agentId: 'a-1', createdAt: at(5) }),
      review({ id: 'p1-new', prId: 'pr-1', agentId: 'a-1', createdAt: at(30) }),
    ];

    expect(latestReviewPerAgent(rows).map((r) => r.id).sort()).toEqual(['p1-new', 'p2']);
  });

  it('returns an empty list for empty input', () => {
    expect(latestReviewPerAgent([])).toEqual([]);
  });
});

describe('rollupReviews', () => {
  it('takes the worst verdict across agents (approve + request_changes)', () => {
    const latest = latestReviewPerAgent([
      review({ id: 'r-1', agentId: 'a-1', verdict: 'approve' }),
      review({ id: 'r-2', agentId: 'a-2', verdict: 'request_changes' }),
    ]);

    expect(rollupReviews(latest, new Map(), new Map()).verdict).toBe('request_changes');
  });

  it('ranks request_changes > comment > approve regardless of input order', () => {
    const roll = (verdicts: string[]) =>
      rollupReviews(
        verdicts.map((verdict, i) => review({ id: `r-${i}`, agentId: `a-${i}`, verdict })),
        new Map(),
        new Map(),
      ).verdict;

    expect(roll(['approve', 'comment'])).toBe('comment');
    expect(roll(['comment', 'approve'])).toBe('comment');
    expect(roll(['request_changes', 'comment', 'approve'])).toBe('request_changes');
    expect(roll(['approve'])).toBe('approve');
  });

  it('ignores null and unrecognised verdicts', () => {
    const latest = [
      review({ id: 'r-1', agentId: 'a-1', verdict: null }),
      review({ id: 'r-2', agentId: 'a-2', verdict: 'wat' }),
      review({ id: 'r-3', agentId: 'a-3', verdict: 'approve' }),
    ];

    expect(rollupReviews(latest, new Map(), new Map()).verdict).toBe('approve');
  });

  it('takes the lowest score across agents (100 and 61 → 61)', () => {
    const latest = latestReviewPerAgent([
      review({ id: 'r-1', agentId: 'a-1', score: 100 }),
      review({ id: 'r-2', agentId: 'a-2', score: 61 }),
    ]);

    expect(rollupReviews(latest, new Map(), new Map()).score).toBe(61);
  });

  it('never lets a null score override a number', () => {
    const latest = [
      review({ id: 'r-1', agentId: 'a-1', score: null }),
      review({ id: 'r-2', agentId: 'a-2', score: 72 }),
      review({ id: 'r-3', agentId: 'a-3', score: null }),
    ];

    expect(rollupReviews(latest, new Map(), new Map()).score).toBe(72);
  });

  it('reports score null when every review is unscored', () => {
    const latest = [
      review({ id: 'r-1', agentId: 'a-1', score: null }),
      review({ id: 'r-2', agentId: 'a-2', score: null }),
    ];

    expect(rollupReviews(latest, new Map(), new Map()).score).toBeNull();
  });

  it('sums findings severities across the per-agent-latest reviews only', () => {
    const rows = [
      review({ id: 'r-old', agentId: 'a-1', score: 20, createdAt: at(0) }),
      review({ id: 'r-new', agentId: 'a-1', score: 80, createdAt: at(30) }),
      review({ id: 'r-b', agentId: 'a-2', score: 90, createdAt: at(10) }),
    ];
    const findingsByReview = new Map([
      ['r-old', findings(['CRITICAL', 'CRITICAL', 'WARNING'])], // superseded re-run
      ['r-new', findings(['WARNING', 'SUGGESTION'])],
      ['r-b', findings(['CRITICAL'])],
    ]);

    const out = rollupReviews(latestReviewPerAgent(rows), findingsByReview, new Map());

    // The re-run replaces its earlier review: counted once, old findings gone.
    expect(out.findingsCount).toBe(3);
    expect(out.severities).toEqual({ critical: 1, warning: 1, suggestion: 1 });
    expect(out.score).toBe(80);
  });

  it("sums each run's blockers, counting a run at most once", () => {
    const latest = [
      review({ id: 'r-1', agentId: 'a-1', runId: 'run-1' }),
      review({ id: 'r-2', agentId: 'a-2', runId: 'run-2' }),
      review({ id: 'r-3', agentId: 'a-3', runId: 'run-2' }),
    ];
    const blockersByRun = new Map([
      ['run-1', 2],
      ['run-2', 3],
    ]);

    expect(rollupReviews(latest, new Map(), blockersByRun).blockers).toBe(5);
  });

  it('contributes 0 blockers for a review with runId null, a missing run, or null blockers', () => {
    const latest = [
      review({ id: 'r-seed', agentId: 'a-1', runId: null }), // pnpm db:seed writes these
      review({ id: 'r-gone', agentId: 'a-2', runId: 'run-missing' }),
      review({ id: 'r-null', agentId: 'a-3', runId: 'run-null' }),
      review({ id: 'r-ok', agentId: 'a-4', runId: 'run-ok' }),
    ];
    const blockersByRun = new Map<string, number | null>([
      ['run-null', null],
      ['run-ok', 4],
    ]);

    expect(rollupReviews(latest, new Map(), blockersByRun).blockers).toBe(4);
  });

  it('rolls empty input up to zeros and nulls', () => {
    expect(rollupReviews([], new Map(), new Map())).toEqual({
      score: null,
      verdict: null,
      findingsCount: 0,
      blockers: 0,
      severities: { critical: 0, warning: 0, suggestion: 0 },
    });
  });
});
