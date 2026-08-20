import { and, eq } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type {
  Intent,
  IntentConfidence,
  IntentDetailWrite,
  StoredIntentDetail,
} from '@devdigest/shared';
import type { PullRow } from '../../../db/rows.js';

// ---- PR lookup (workspace-scoped) -----------------------------------------

export async function getPull(
  db: Db,
  workspaceId: string,
  prId: string,
): Promise<PullRow | undefined> {
  const [row] = await db
    .select()
    .from(t.pullRequests)
    .where(and(eq(t.pullRequests.workspaceId, workspaceId), eq(t.pullRequests.id, prId)));
  return row;
}

export async function getRepo(
  db: Db,
  repoId: string,
): Promise<typeof t.repos.$inferSelect | undefined> {
  const [row] = await db.select().from(t.repos).where(eq(t.repos.id, repoId));
  return row;
}

export async function getPrFiles(
  db: Db,
  prId: string,
): Promise<(typeof t.prFiles.$inferSelect)[]> {
  return db.select().from(t.prFiles).where(eq(t.prFiles.prId, prId));
}

/**
 * Record the commit a review just ran against, so the PR list can derive
 * `reviewed` vs `needs_review` (head moved since the last review) vs `stale`.
 */
export async function markReviewed(db: Db, prId: string, sha: string): Promise<void> {
  await db
    .update(t.pullRequests)
    .set({ lastReviewedSha: sha })
    .where(eq(t.pullRequests.id, prId));
}

// ---- intent ---------------------------------------------------------------

export async function upsertIntent(db: Db, prId: string, intent: Intent): Promise<void> {
  await db
    .insert(t.prIntent)
    .values({
      prId,
      intent: intent.intent,
      inScope: intent.in_scope,
      outOfScope: intent.out_of_scope,
    })
    .onConflictDoUpdate({
      target: t.prIntent.prId,
      set: { intent: intent.intent, inScope: intent.in_scope, outOfScope: intent.out_of_scope },
    });
}

export async function getIntent(db: Db, prId: string): Promise<Intent | undefined> {
  const [row] = await db.select().from(t.prIntent).where(eq(t.prIntent.prId, prId));
  if (!row) return undefined;
  return { intent: row.intent, in_scope: row.inScope, out_of_scope: row.outOfScope };
}

// ---- intent detail (L03 Intent Layer) --------------------------------------

/** Upsert the full classified intent (summary+scope+sources+observability). */
export async function upsertIntentDetail(
  db: Db,
  prId: string,
  input: IntentDetailWrite,
): Promise<void> {
  const values = {
    intent: input.intent,
    inScope: input.in_scope,
    outOfScope: input.out_of_scope,
    riskAreas: input.risk_areas,
    confidence: input.confidence,
    sources: input.sources,
    model: input.model ?? null,
    headSha: input.head_sha ?? null,
    tokensIn: input.tokens_in ?? null,
    tokensOut: input.tokens_out ?? null,
    costUsd: input.cost_usd ?? null,
  };
  await db
    .insert(t.prIntent)
    .values({ prId, ...values })
    .onConflictDoUpdate({
      target: t.prIntent.prId,
      set: { ...values, updatedAt: new Date() },
    });
}

/** Row → domain mapping at the repository boundary (`stale` is computed by the service). */
export async function getIntentDetail(
  db: Db,
  prId: string,
): Promise<StoredIntentDetail | undefined> {
  const [row] = await db.select().from(t.prIntent).where(eq(t.prIntent.prId, prId));
  if (!row) return undefined;
  return {
    pr_id: row.prId,
    intent: row.intent,
    in_scope: row.inScope,
    out_of_scope: row.outOfScope,
    risk_areas: row.riskAreas,
    confidence: row.confidence as IntentConfidence,
    sources: row.sources,
    model: row.model,
    head_sha: row.headSha,
    generated_at: row.updatedAt.toISOString(),
  };
}
