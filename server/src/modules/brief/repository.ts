import { and, desc, eq, inArray } from 'drizzle-orm';
import { BriefMissingInput, PrBriefContent } from '@devdigest/shared';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { ReviewRollupInput } from '../_shared/review-rollup.js';
import { sumSpend, type PrSpend, type SpendEntry } from './helpers.js';

/**
 * PR Brief data access — the ONLY file in this slice that runs Drizzle.
 *
 * Every method speaks the domain, not SQL, and maps rows to plain shapes at this
 * boundary: no `$inferSelect` row type ever appears in a signature, so the table
 * layout stays free to move without touching the service or the API contract.
 *
 * TENANCY: `pr_brief`, `pr_intent`, `pr_files` and `findings` carry no
 * `workspace_id` — they inherit it through the `pr_id` FK, exactly as the intent
 * slice does. The caller MUST have resolved the PR through the workspace-scoped
 * `getPull` before calling anything here (AC-37). Only `agent_runs`, which does
 * carry the column, is filtered on it directly.
 *
 * RETENTION: nothing here deletes a brief (N11). A regeneration overwrites the
 * single per-PR row in place via `onConflictDoUpdate`.
 */

/** A cached brief as the service consumes it (`generatedAt` is the row's `updated_at`). */
export interface StoredBrief {
  prId: string;
  /** Already validated against the `PrBriefContent` contract — see `getBrief`. */
  content: PrBriefContent;
  /** The PR state this content was generated for (AC-4); null on a pre-0016 row. */
  headSha: string | null;
  fingerprint: string | null;
  /**
   * The generation's own missing-input notes (AC-32 – AC-34, NFR-3). Always an
   * array here — a NULL column (a pre-0017 row) reads as `[]`. The service serves
   * only the ONE-TIME notes from this list; the live-recomputable ones are
   * re-derived per read (`helpers.mergeMissingInputs`).
   */
  missingInputs: BriefMissingInput[];
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  /** ISO timestamp of the last write — the card's `generated_at` provenance. */
  generatedAt: string;
}

/** Everything one generation persists (AC-4, AC-8). */
export interface BriefWrite {
  /** Post-grounding content only — an ungrounded generation is never persisted (AC-11). */
  content: PrBriefContent;
  headSha: string;
  fingerprint: string;
  /** What this generation could not consult — persisted so a later READ can still report it. */
  missingInputs: BriefMissingInput[];
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

/**
 * A grounded finding of one of the PR's reviews.
 *
 * NOTE the column rename: the DB column is `findings.file`, the contract side
 * says `path`. The mapping happens HERE, once, so nothing downstream has to
 * remember which name it is holding.
 *
 * Deliberately WITHOUT `acceptedAt` / `dismissedAt`: per AC-41 a finding action
 * must leave the brief payload byte-identical, which includes `findings_count`.
 * Exposing the timestamps here would invite a filter that breaks that.
 */
export interface BriefFinding {
  id: string;
  reviewId: string;
  path: string;
  startLine: number;
  endLine: number;
  severity: string;
  category: string;
  title: string;
}

export class BriefRepository {
  constructor(private db: Db) {}

  // ---- cached brief -------------------------------------------------------

  /**
   * The PR's cached brief, or `undefined` when there is none.
   *
   * The `json` column is typed `unknown` in the schema on purpose: this method is
   * the trust boundary that `safeParse`s the blob into the `PrBriefContent`
   * contract. A blob that no longer matches (an older shape, a hand-edited row)
   * is treated as NO cached brief — the row is never deleted (N11) and the next
   * regeneration overwrites it in place.
   */
  async getBrief(prId: string): Promise<StoredBrief | undefined> {
    const [row] = await this.db.select().from(t.prBrief).where(eq(t.prBrief.prId, prId));
    if (!row) return undefined;

    const parsed = PrBriefContent.safeParse(row.json);
    if (!parsed.success) return undefined;

    // The notes column is a weaker trust boundary than `json`: a null (pre-0017
    // row) or an unreadable blob degrades to "nothing one-time to report" rather
    // than to "no cached brief" — losing a note must never hide the content.
    const notes = BriefMissingInput.array().safeParse(row.missingInputs ?? []);

    return {
      prId: row.prId,
      content: parsed.data,
      headSha: row.headSha,
      fingerprint: row.fingerprint,
      missingInputs: notes.success ? notes.data : [],
      model: row.model,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      costUsd: row.costUsd,
      generatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Write the PR's brief, replacing any previous one wholesale (AC-6). Never deletes (N11). */
  async upsertBrief(prId: string, input: BriefWrite): Promise<void> {
    const values = {
      json: input.content,
      headSha: input.headSha,
      fingerprint: input.fingerprint,
      missingInputs: input.missingInputs,
      model: input.model,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      costUsd: input.costUsd,
    };
    await this.db
      .insert(t.prBrief)
      .values({ prId, ...values })
      .onConflictDoUpdate({
        target: t.prBrief.prId,
        set: { ...values, updatedAt: new Date() },
      });
  }

  // ---- deterministic header inputs ---------------------------------------

  /**
   * The PR's `kind = 'review'` rows, newest first, in the shape
   * `_shared/review-rollup` reads.
   *
   * The `kind` filter is this query's job — `latestReviewPerAgent` does not
   * apply it, and a `'summary'` row is not an agent verdict. Reducing to the
   * per-agent-latest set is the CALLER's job (`latestReviewPerAgent`), so the
   * repository stays a query layer and the rollup rule stays in one place.
   */
  async latestReviewRowsForPull(prId: string): Promise<ReviewRollupInput[]> {
    return this.db
      .select({
        id: t.reviews.id,
        prId: t.reviews.prId,
        agentId: t.reviews.agentId,
        score: t.reviews.score,
        verdict: t.reviews.verdict,
        runId: t.reviews.runId,
        createdAt: t.reviews.createdAt,
      })
      .from(t.reviews)
      .where(and(eq(t.reviews.prId, prId), eq(t.reviews.kind, 'review')))
      .orderBy(desc(t.reviews.createdAt));
  }

  /** Findings of the given reviews (one `IN` query), mapped `file` → `path`. */
  async findingsForReviews(reviewIds: readonly string[]): Promise<BriefFinding[]> {
    if (reviewIds.length === 0) return [];
    const rows = await this.db
      .select({
        id: t.findings.id,
        reviewId: t.findings.reviewId,
        file: t.findings.file,
        startLine: t.findings.startLine,
        endLine: t.findings.endLine,
        severity: t.findings.severity,
        category: t.findings.category,
        title: t.findings.title,
      })
      .from(t.findings)
      .where(inArray(t.findings.reviewId, [...reviewIds]));

    return rows.map((r) => ({
      id: r.id,
      reviewId: r.reviewId,
      path: r.file,
      startLine: r.startLine,
      endLine: r.endLine,
      severity: r.severity,
      category: r.category,
      title: r.title,
    }));
  }

  /**
   * `agent_runs.id` → that run's blocker count, for `rollupReviews` (AC-17, Q1).
   *
   * `reviews.run_id` is nullable and has NO FK, so a review can point at a run
   * that no longer exists: such a run is simply absent from the map and the
   * rollup counts 0 for it, never claiming a blocker it cannot evidence.
   */
  async blockersForRuns(runIds: readonly string[]): Promise<Map<string, number | null>> {
    if (runIds.length === 0) return new Map();
    const rows = await this.db
      .select({ id: t.agentRuns.id, blockers: t.agentRuns.blockers })
      .from(t.agentRuns)
      .where(inArray(t.agentRuns.id, [...runIds]));
    return new Map(rows.map((r) => [r.id, r.blockers] as const));
  }

  // ---- cost rollup --------------------------------------------------------

  /**
   * Total recorded model spend for the PR: every `agent_runs` row + the intent
   * classification + the brief generation (AC-9, [D5]).
   *
   * This is the first code to RE-READ the intent cost columns, which
   * `contracts/intent.ts` still documents as "persisted, never re-read" — that
   * comment is now out of date, but it lives in a frozen contract file and is
   * left for a separate pass rather than edited here.
   *
   * Nullability is load-bearing: `sumSpend` returns null (not 0) for a metric
   * nothing recorded, so the card renders an em dash rather than `$0.00` (AC-19).
   */
  async getPrSpend(workspaceId: string, prId: string): Promise<PrSpend> {
    const [runs, intent, brief] = await Promise.all([
      this.db
        .select({
          costUsd: t.agentRuns.costUsd,
          tokensIn: t.agentRuns.tokensIn,
          tokensOut: t.agentRuns.tokensOut,
        })
        .from(t.agentRuns)
        .where(and(eq(t.agentRuns.workspaceId, workspaceId), eq(t.agentRuns.prId, prId))),
      this.db
        .select({
          costUsd: t.prIntent.costUsd,
          tokensIn: t.prIntent.tokensIn,
          tokensOut: t.prIntent.tokensOut,
        })
        .from(t.prIntent)
        .where(eq(t.prIntent.prId, prId)),
      this.db
        .select({
          costUsd: t.prBrief.costUsd,
          tokensIn: t.prBrief.tokensIn,
          tokensOut: t.prBrief.tokensOut,
        })
        .from(t.prBrief)
        .where(eq(t.prBrief.prId, prId)),
    ]);

    const entries: SpendEntry[] = [...runs, ...intent, ...brief];
    return sumSpend(entries);
  }
}
