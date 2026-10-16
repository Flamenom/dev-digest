import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  doublePrecision,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { workspaces } from './core';
import { pullRequests } from './pulls';

// ============================================================ Eval / Conformance / Compose

export const evalCases = pgTable(
  'eval_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ownerKind: text('owner_kind', { enum: ['skill', 'agent'] }).notNull(),
    ownerId: uuid('owner_id').notNull(),
    name: text('name').notNull(),
    inputDiff: text('input_diff'),
    inputFiles: jsonb('input_files'),
    inputMeta: jsonb('input_meta'),
    expectedOutput: jsonb('expected_output'),
    notes: text('notes'),
    /**
     * Soft provenance pointer to the `findings` row this case was created from
     * (one-click "Turn into eval case"). Nullable: seeded cases have no real
     * provenance.
     *
     * DELIBERATELY NO FOREIGN KEY. `findings` rows are deleted when their
     * review / run is deleted from the timeline; a hard FK would cascade-delete
     * eval cases when a user merely cleans up run history — exactly the
     * hand-curated data this feature exists to protect. A dangling value is a
     * legal state and renders as "source finding no longer exists".
     */
    sourceFindingId: uuid('source_finding_id'),
  },
  (t) => ({
    /**
     * Makes one-click creation from a finding idempotent: a re-click returns the
     * existing case instead of creating a duplicate.
     *
     * Plain UNIQUE on purpose — Postgres treats NULLs as distinct, so the many
     * seeded cases with `source_finding_id = null` all remain legal. Do NOT add
     * `NULLS NOT DISTINCT`: it would permit only ONE row without provenance.
     */
    sourceFindingUq: uniqueIndex('eval_cases_source_finding_uq').on(t.sourceFindingId),
  }),
);

export const evalRuns = pgTable(
  'eval_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => evalCases.id, { onDelete: 'cascade' }),
    ranAt: timestamp('ran_at', { withTimezone: true }).defaultNow().notNull(),
    actualOutput: jsonb('actual_output'),
    pass: boolean('pass'),
    recall: doublePrecision('recall'),
    precision: doublePrecision('precision'),
    citationAccuracy: doublePrecision('citation_accuracy'),
    durationMs: integer('duration_ms'),
    costUsd: doublePrecision('cost_usd'),
    /**
     * Groups the rows of one batch run.
     *
     * DELIBERATELY NO BATCH HEADER TABLE. A batch is derived by grouping
     * `eval_runs` on `batch_id`; `cases_total` is knowable because one pending
     * row per selected case is inserted up front. This is what keeps the whole
     * feature inside one additive migration. Nullable: rows written before this
     * migration belong to no batch.
     */
    batchId: uuid('batch_id'),
    /** Agent version snapshotted at batch start, so a batch is always labelled with the version it actually executed. Nullable for pre-existing rows. */
    agentVersion: integer('agent_version'),
    /**
     * Denormalized *agent* id, for cheap dashboard grouping.
     *
     * NOT A TENANCY COLUMN. Tenancy is still resolved by joining
     * `eval_cases.workspace_id` (that FK is ON DELETE CASCADE, so no orphan run
     * can exist). A repository method must NEVER filter by `owner_id` alone —
     * the index below makes such a query fast, and therefore tempting, but it
     * would be a cross-workspace leak.
     */
    ownerId: uuid('owner_id'),
  },
  (t) => ({
    /** Batch aggregation on read: every row of one batch. */
    batchIdx: index('eval_runs_batch_idx').on(t.batchId),
    /** Per-agent dashboard history: `where owner_id = … order by ran_at desc`. Leftmost-prefix on owner_id is required for this index to be used. */
    ownerRanIdx: index('eval_runs_owner_ran_idx').on(t.ownerId, t.ranAt.desc()),
  }),
);

export const conformanceChecks = pgTable('conformance_checks', {
  id: uuid('id').primaryKey().defaultRandom(),
  prId: uuid('pr_id')
    .notNull()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  specId: text('spec_id').notNull(),
  completenessPct: doublePrecision('completeness_pct'),
  items: jsonb('items'),
});

export const composedReviews = pgTable('composed_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  prId: uuid('pr_id')
    .notNull()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  verdict: text('verdict'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  githubReviewId: text('github_review_id'),
});
