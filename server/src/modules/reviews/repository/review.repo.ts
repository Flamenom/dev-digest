import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type { Finding } from '@devdigest/shared';
import type { FindingRow, PullRow } from '../../../db/rows.js';

export type ReviewRow = typeof t.reviews.$inferSelect;

// ---- reviews + findings ---------------------------------------------------

export async function insertReview(
  db: Db,
  values: {
    workspaceId: string;
    prId: string;
    agentId: string | null;
    runId: string | null;
    kind: 'summary' | 'review';
    verdict: string | null;
    summary: string | null;
    score: number | null;
    model: string | null;
    /** AC-1 — head SHA of the reviewed diff; null when unknown. */
    headSha: string | null;
  },
): Promise<ReviewRow> {
  const [row] = await db.insert(t.reviews).values(values).returning();
  return row!;
}

export async function insertFindings(
  db: Db,
  reviewId: string,
  findings: Finding[],
): Promise<FindingRow[]> {
  if (findings.length === 0) return [];
  const rows = await db
    .insert(t.findings)
    .values(
      findings.map((f) => ({
        reviewId,
        file: f.file,
        startLine: f.start_line,
        endLine: f.end_line,
        severity: f.severity,
        category: f.category,
        title: f.title,
        rationale: f.rationale,
        suggestion: f.suggestion ?? null,
        confidence: f.confidence,
        kind: f.kind ?? 'finding',
        trifectaComponents: f.trifecta_components ?? null,
      })),
    )
    .returning();
  return rows;
}

/**
 * Reviews for a PR (newest first), each with its findings and the raw id of
 * the user who started the producing run (`agent_runs.initiated_by`; null for
 * legacy rows or reviews without a run). `reviews.run_id` has no FK, hence the
 * LEFT JOIN.
 */
export async function reviewsForPull(
  db: Db,
  prId: string,
): Promise<{ review: ReviewRow; findings: FindingRow[]; initiatedBy: string | null }[]> {
  const rows = await db
    .select({ review: t.reviews, initiatedBy: t.agentRuns.initiatedBy })
    .from(t.reviews)
    .leftJoin(t.agentRuns, eq(t.agentRuns.id, t.reviews.runId))
    .where(eq(t.reviews.prId, prId))
    .orderBy(desc(t.reviews.createdAt));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.review.id);
  const findings = await db.select().from(t.findings).where(inArray(t.findings.reviewId, ids));
  return rows.map(({ review, initiatedBy }) => ({
    review,
    findings: findings.filter((f) => f.reviewId === review.id),
    initiatedBy: initiatedBy ?? null,
  }));
}

export async function getReview(db: Db, reviewId: string): Promise<ReviewRow | undefined> {
  const [row] = await db.select().from(t.reviews).where(eq(t.reviews.id, reviewId));
  return row;
}

/** Delete a whole review (one agent's run) + its findings (cascade), scoped
 *  to the workspace. Returns false if not found in the workspace. */
export async function deleteReview(
  db: Db,
  workspaceId: string,
  reviewId: string,
): Promise<boolean> {
  const rows = await db
    .delete(t.reviews)
    .where(and(eq(t.reviews.workspaceId, workspaceId), eq(t.reviews.id, reviewId)))
    .returning({ id: t.reviews.id });
  return rows.length > 0;
}

// ---- finding actions ------------------------------------------------------

export async function getFinding(db: Db, findingId: string): Promise<FindingRow | undefined> {
  const [row] = await db.select().from(t.findings).where(eq(t.findings.id, findingId));
  return row;
}

/** Resolve workspace_id + pr_id for a finding (via review → pr). */
export async function findingContext(
  db: Db,
  findingId: string,
): Promise<{ finding: FindingRow; review: ReviewRow; pull: PullRow } | undefined> {
  const finding = await getFinding(db, findingId);
  if (!finding) return undefined;
  const review = await getReview(db, finding.reviewId);
  if (!review) return undefined;
  const [pull] = await db
    .select()
    .from(t.pullRequests)
    .where(eq(t.pullRequests.id, review.prId));
  if (!pull) return undefined;
  return { finding, review, pull };
}

export async function setFindingAccepted(
  db: Db,
  findingId: string,
  at: Date | null,
  actedBy: string | null = null,
): Promise<FindingRow | undefined> {
  const [row] = await db
    .update(t.findings)
    .set({ acceptedAt: at, dismissedAt: null, actedBy })
    .where(eq(t.findings.id, findingId))
    .returning();
  return row;
}

export async function setFindingDismissed(
  db: Db,
  findingId: string,
  at: Date | null,
  actedBy: string | null = null,
): Promise<FindingRow | undefined> {
  const [row] = await db
    .update(t.findings)
    .set({ dismissedAt: at, acceptedAt: null, actedBy })
    .where(eq(t.findings.id, findingId))
    .returning();
  return row;
}
