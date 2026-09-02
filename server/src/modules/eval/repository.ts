/**
 * L06 Eval Pipeline — data access. The ONLY file in `modules/eval/` that may
 * import Drizzle or `db/schema` (onion §5); `service.ts`, `runner.ts` and
 * `dashboard.ts` speak the domain shapes in `./types.js` and nothing else.
 *
 * ---------------------------------------------------------------------------
 * TENANCY — read this before adding a method.
 * ---------------------------------------------------------------------------
 * `eval_runs` HAS NO `workspace_id`. Its `owner_id` denormalizes the *agent*
 * id for cheap dashboard grouping and is **not** a tenancy column (§3, plan
 * §Concerns C14). The `eval_runs_owner_ran_idx (owner_id, ran_at desc)` index
 * makes an `owner_id`-only predicate fast, and therefore tempting — it is a
 * cross-workspace leak.
 *
 * The invariant every method here upholds: **tenancy is resolved by joining
 * `eval_cases.workspace_id`**, on reads AND on writes. `eval_runs.case_id` is
 * `ON DELETE CASCADE` onto `eval_cases`, so no orphan run can exist and the
 * join is total. Where an agent id also narrows the query it is an additional
 * predicate on top of that join (and it is what lets the index be used), never
 * a replacement for it.
 *
 * A batch is DERIVED by grouping on `batch_id` — there is no batch header
 * table (§3), which is why `cases_total` is `count(*)` over the pending rows
 * inserted up front (§5.3).
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import {
  DuplicateSourceFindingError,
  type EvalBatchRow,
  type EvalCaseDeleteResult,
  type EvalCaseDomain,
  type EvalCaseLinkRow,
  type EvalCasePatch,
  type EvalExecutor,
  type EvalPendingRun,
  type EvalRunCompletion,
  type EvalRunDomain,
  type NewEvalCase,
} from './types.js';

/** Postgres `unique_violation`. */
const PG_UNIQUE_VIOLATION = '23505';
/** The index migration 0018 adds; the one-click "turn into eval case" de-duplicator (§3). */
const SOURCE_FINDING_UQ = 'eval_cases_source_finding_uq';

/**
 * Matched by SHAPE, not `instanceof PostgresError` — the same reason `ZodError`
 * is shape-matched in this repo (a vendored second copy of a library makes
 * `instanceof` unreliable), and it keeps the `postgres` types out of the
 * signature.
 */
function isSourceFindingUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
  if (e.code !== PG_UNIQUE_VIOLATION) return false;
  return e.constraint_name === SOURCE_FINDING_UQ || e.constraint === SOURCE_FINDING_UQ;
}

/** `eval_cases` columns, projected once so every read maps through the same shape. */
const CASE_COLUMNS = {
  id: t.evalCases.id,
  workspaceId: t.evalCases.workspaceId,
  ownerKind: t.evalCases.ownerKind,
  ownerId: t.evalCases.ownerId,
  name: t.evalCases.name,
  inputDiff: t.evalCases.inputDiff,
  inputFiles: t.evalCases.inputFiles,
  inputMeta: t.evalCases.inputMeta,
  expectedOutput: t.evalCases.expectedOutput,
  notes: t.evalCases.notes,
  sourceFindingId: t.evalCases.sourceFindingId,
} as const;

/** Row → domain. `input_diff` is nullable in the DB but not in the contract: `null → ''` (plan C6). */
function toCase(row: {
  id: string;
  workspaceId: string;
  ownerKind: 'skill' | 'agent';
  ownerId: string;
  name: string;
  inputDiff: string | null;
  inputFiles: unknown;
  inputMeta: unknown;
  expectedOutput: unknown;
  notes: string | null;
  sourceFindingId: string | null;
}): EvalCaseDomain {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ownerKind: row.ownerKind,
    ownerId: row.ownerId,
    name: row.name,
    inputDiff: row.inputDiff ?? '',
    inputFiles: row.inputFiles,
    inputMeta: row.inputMeta,
    expectedOutput: row.expectedOutput,
    notes: row.notes,
    sourceFindingId: row.sourceFindingId,
  };
}

/** `eval_runs` ⋈ `eval_cases.name`, projected once. */
const RUN_COLUMNS = {
  id: t.evalRuns.id,
  caseId: t.evalRuns.caseId,
  caseName: t.evalCases.name,
  ranAt: t.evalRuns.ranAt,
  actualOutput: t.evalRuns.actualOutput,
  pass: t.evalRuns.pass,
  recall: t.evalRuns.recall,
  precision: t.evalRuns.precision,
  citationAccuracy: t.evalRuns.citationAccuracy,
  durationMs: t.evalRuns.durationMs,
  costUsd: t.evalRuns.costUsd,
  batchId: t.evalRuns.batchId,
  agentVersion: t.evalRuns.agentVersion,
  ownerId: t.evalRuns.ownerId,
} as const;

function toRun(row: {
  id: string;
  caseId: string;
  caseName: string;
  ranAt: Date;
  actualOutput: unknown;
  pass: boolean | null;
  recall: number | null;
  precision: number | null;
  citationAccuracy: number | null;
  durationMs: number | null;
  costUsd: number | null;
  batchId: string | null;
  agentVersion: number | null;
  ownerId: string | null;
}): EvalRunDomain {
  return {
    id: row.id,
    caseId: row.caseId,
    caseName: row.caseName,
    ranAt: row.ranAt,
    actualOutput: row.actualOutput,
    // `pass === null` alone cannot tell "errored" from "not run yet" (§5.3);
    // `actual_output IS NULL` is the pending marker, so surface it explicitly.
    finished: row.actualOutput !== null,
    pass: row.pass,
    recall: row.recall,
    precision: row.precision,
    citationAccuracy: row.citationAccuracy,
    durationMs: row.durationMs,
    costUsd: row.costUsd,
    batchId: row.batchId,
    agentVersion: row.agentVersion,
    ownerId: row.ownerId,
  };
}

/**
 * A raw `sql` fragment carries no column type, so the driver's timestamptz →
 * `Date` decoding is not visible to TypeScript for `min(ran_at)` / `max(ran_at)`.
 * Normalize here rather than asserting, so a string never leaks out as a `Date`.
 */
function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

export class EvalRepository {
  constructor(private db: Db) {}

  /** Every method takes an optional `tx` so a service can span several calls in one `db.transaction`. */
  private exec(tx?: EvalExecutor): Db {
    // The transaction handle exposes the same query builders as the client;
    // the cast keeps every call site free of a `Db | PgTransaction` union that
    // TypeScript cannot resolve overloads across.
    return (tx ?? this.db) as Db;
  }

  // =========================================================================
  // Cases
  // =========================================================================

  /** Every case of one agent (or skill), by name — the case list of screens E/F. */
  async listCasesForOwner(
    workspaceId: string,
    ownerId: string,
    tx?: EvalExecutor,
  ): Promise<EvalCaseDomain[]> {
    const rows = await this.exec(tx)
      .select(CASE_COLUMNS)
      .from(t.evalCases)
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.ownerId, ownerId)))
      // `eval_cases` has no created_at; `name` is the only stable, meaningful
      // order, and the UI lists cases by name anyway.
      .orderBy(asc(t.evalCases.name), asc(t.evalCases.id));
    return rows.map(toCase);
  }

  /** One case. `undefined` for a missing row AND for another workspace's row — the caller answers 404, never 403. */
  async getCase(
    workspaceId: string,
    caseId: string,
    tx?: EvalExecutor,
  ): Promise<EvalCaseDomain | undefined> {
    const [row] = await this.exec(tx)
      .select(CASE_COLUMNS)
      .from(t.evalCases)
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.id, caseId)));
    return row ? toCase(row) : undefined;
  }

  /**
   * Insert one case.
   *
   * @throws {DuplicateSourceFindingError} when `eval_cases_source_finding_uq`
   * fires — the race the service's read-then-write idempotency check cannot
   * close (R1, AC-9). No `postgres` error object escapes this method.
   */
  async insertCase(input: NewEvalCase, tx?: EvalExecutor): Promise<EvalCaseDomain> {
    try {
      const [row] = await this.exec(tx)
        .insert(t.evalCases)
        .values({
          workspaceId: input.workspaceId,
          ownerKind: input.ownerKind,
          ownerId: input.ownerId,
          name: input.name,
          inputDiff: input.inputDiff,
          inputFiles: input.inputFiles ?? null,
          inputMeta: input.inputMeta ?? null,
          expectedOutput: input.expectedOutput ?? null,
          notes: input.notes ?? null,
          sourceFindingId: input.sourceFindingId ?? null,
        })
        .returning(CASE_COLUMNS);
      // `.returning()` on a single-row insert always yields the row; the guard
      // exists so the impossible path is a clear error, not `undefined`.
      if (!row) throw new Error('insertCase: insert returned no row');
      return toCase(row);
    } catch (err) {
      if (input.sourceFindingId && isSourceFindingUniqueViolation(err)) {
        throw new DuplicateSourceFindingError(input.sourceFindingId);
      }
      throw err;
    }
  }

  /**
   * Patch a case. Only the keys present in `patch` are written — the request
   * body is never spread into the update (A08, mass assignment).
   * `undefined` when the case is missing or belongs to another workspace.
   */
  async updateCase(
    workspaceId: string,
    caseId: string,
    patch: EvalCasePatch,
    tx?: EvalExecutor,
  ): Promise<EvalCaseDomain | undefined> {
    const values = {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.inputDiff !== undefined ? { inputDiff: patch.inputDiff } : {}),
      ...(patch.inputFiles !== undefined ? { inputFiles: patch.inputFiles } : {}),
      ...(patch.inputMeta !== undefined ? { inputMeta: patch.inputMeta } : {}),
      ...(patch.expectedOutput !== undefined ? { expectedOutput: patch.expectedOutput } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    };
    if (Object.keys(values).length === 0) return this.getCase(workspaceId, caseId, tx);
    const [row] = await this.exec(tx)
      .update(t.evalCases)
      .set(values)
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.id, caseId)))
      .returning(CASE_COLUMNS);
    return row ? toCase(row) : undefined;
  }

  /**
   * Guarded delete (R7, AC-12). Deleting a case CASCADES its `eval_runs`, i.e.
   * it erases history and shrinks every past batch (§5.2) — so a case with runs
   * is only removed when `force` is set. Reports facts; the service maps them
   * to 404 / 409 `case_has_runs` / 200.
   */
  async deleteCase(
    workspaceId: string,
    caseId: string,
    opts: { force?: boolean } = {},
    tx?: EvalExecutor,
  ): Promise<EvalCaseDeleteResult> {
    const db = this.exec(tx);
    const existing = await this.getCase(workspaceId, caseId, db);
    if (!existing) return { found: false, deleted: false, runCount: 0 };

    const runCount = await this.countRunsForCase(workspaceId, caseId, db);
    if (runCount > 0 && !opts.force) return { found: true, deleted: false, runCount };

    const deleted = await db
      .delete(t.evalCases)
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.id, caseId)))
      .returning({ id: t.evalCases.id });
    return { found: true, deleted: deleted.length > 0, runCount };
  }

  /** How many runs a delete would cascade away. Workspace-joined: `eval_runs` alone carries no tenant. */
  async countRunsForCase(workspaceId: string, caseId: string, tx?: EvalExecutor): Promise<number> {
    const [row] = await this.exec(tx)
      .select({ count: sql<number>`count(*)::int` })
      .from(t.evalRuns)
      .innerJoin(t.evalCases, eq(t.evalCases.id, t.evalRuns.caseId))
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalRuns.caseId, caseId)));
    return row?.count ?? 0;
  }

  /** The read half of R1's idempotency: does this finding already have a case? */
  async findCaseBySourceFinding(
    workspaceId: string,
    findingId: string,
    tx?: EvalExecutor,
  ): Promise<EvalCaseDomain | undefined> {
    const [row] = await this.exec(tx)
      .select(CASE_COLUMNS)
      .from(t.evalCases)
      .where(
        and(
          eq(t.evalCases.workspaceId, workspaceId),
          eq(t.evalCases.sourceFindingId, findingId),
        ),
      );
    return row ? toCase(row) : undefined;
  }

  /** Names already used inside `(workspace_id, owner_id)` — the input to the `-2` / `-3` collision rule (§7). */
  async takenNamesForOwner(
    workspaceId: string,
    ownerId: string,
    tx?: EvalExecutor,
  ): Promise<string[]> {
    const rows = await this.exec(tx)
      .select({ name: t.evalCases.name })
      .from(t.evalCases)
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.ownerId, ownerId)));
    return rows.map((r) => r.name);
  }

  /**
   * R2 — which findings of one PR already have a case, so the PR page can paint
   * the "Eval case ✓" state without touching the frozen `ReviewRecord` contract
   * (§7). Joins `eval_cases.source_finding_id` → `findings` → `reviews` →
   * `pull_requests`; the soft pointer has no FK, so a dangling value simply
   * drops out of this inner join.
   */
  async caseLinksForPull(
    workspaceId: string,
    prId: string,
    tx?: EvalExecutor,
  ): Promise<EvalCaseLinkRow[]> {
    const rows = await this.exec(tx)
      .select({
        findingId: t.findings.id,
        caseId: t.evalCases.id,
        caseName: t.evalCases.name,
      })
      .from(t.evalCases)
      .innerJoin(t.findings, eq(t.findings.id, t.evalCases.sourceFindingId))
      .innerJoin(t.reviews, eq(t.reviews.id, t.findings.reviewId))
      .innerJoin(t.pullRequests, eq(t.pullRequests.id, t.reviews.prId))
      .where(
        and(
          // Both sides are tenant-checked: the case by its own column, the PR by
          // its own. A case may never link a finding from another workspace.
          eq(t.evalCases.workspaceId, workspaceId),
          eq(t.pullRequests.workspaceId, workspaceId),
          eq(t.pullRequests.id, prId),
        ),
      );
    return rows;
  }

  // =========================================================================
  // Runs
  // =========================================================================

  /**
   * Insert one PENDING row per case, up front, before the 202 (§5.3) — this is
   * what makes `cases_total` knowable with no batch header table.
   * `actual_output` stays NULL: that is the pending marker.
   *
   * `caseIds` is filtered through a workspace-scoped select first, so a caller
   * cannot mint runs against another tenant's cases even by guessing ids. The
   * returned list therefore also tells the caller which ids survived.
   */
  async insertPendingRuns(
    workspaceId: string,
    args: { batchId: string; agentVersion: number | null; ownerId: string; caseIds: string[] },
    tx?: EvalExecutor,
  ): Promise<EvalPendingRun[]> {
    if (args.caseIds.length === 0) return [];
    const db = this.exec(tx);

    const owned = await db
      .select({ id: t.evalCases.id })
      .from(t.evalCases)
      .where(
        and(
          eq(t.evalCases.workspaceId, workspaceId),
          eq(t.evalCases.ownerId, args.ownerId),
          inArray(t.evalCases.id, args.caseIds),
        ),
      );
    if (owned.length === 0) return [];

    const rows = await db
      .insert(t.evalRuns)
      .values(
        owned.map((c) => ({
          caseId: c.id,
          batchId: args.batchId,
          agentVersion: args.agentVersion,
          ownerId: args.ownerId,
          actualOutput: null,
        })),
      )
      .returning({ runId: t.evalRuns.id, caseId: t.evalRuns.caseId });
    return rows;
  }

  /**
   * Write the outcome of one case onto its pending row.
   *
   * Takes no `workspaceId` on purpose and it is not a tenancy hole: `runId` is
   * never user input — it is minted by `insertPendingRuns`, which resolved the
   * tenant before the row existed. The `actual_output IS NULL` predicate makes
   * the write idempotent (a retry after the wall-clock sweep cannot resurrect a
   * row already marked errored). Returns whether a row was written.
   */
  async completeRun(
    runId: string,
    values: EvalRunCompletion,
    tx?: EvalExecutor,
  ): Promise<boolean> {
    const rows = await this.exec(tx)
      .update(t.evalRuns)
      .set({
        actualOutput: values.actualOutput,
        pass: values.pass,
        recall: values.recall,
        precision: values.precision,
        citationAccuracy: values.citationAccuracy,
        durationMs: values.durationMs,
        costUsd: values.costUsd,
      })
      .where(and(eq(t.evalRuns.id, runId), isNull(t.evalRuns.actualOutput)))
      .returning({ id: t.evalRuns.id });
    return rows.length > 0;
  }

  /**
   * The newest run of EACH case of one owner, in one `DISTINCT ON` query —
   * what fills `EvalCaseRecord.last_run` (C5) for a whole case list.
   *
   * Keyed off `eval_cases` rather than `eval_runs.owner_id` on purpose: it
   * therefore also sees rows written before migration 0018, whose `owner_id`
   * and `batch_id` are NULL (§3, AC-35). Doing this from `listRunsForAgent`
   * instead would mean reading every run the agent ever produced just to keep
   * the newest one per case.
   */
  async latestRunPerCase(
    workspaceId: string,
    ownerId: string,
    tx?: EvalExecutor,
  ): Promise<Map<string, EvalRunDomain>> {
    const rows = await this.exec(tx)
      .selectDistinctOn([t.evalRuns.caseId], RUN_COLUMNS)
      .from(t.evalRuns)
      .innerJoin(t.evalCases, eq(t.evalCases.id, t.evalRuns.caseId))
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.ownerId, ownerId)))
      // `DISTINCT ON` requires the distinct expression to lead ORDER BY; the
      // `id` tiebreaker keeps the pick deterministic when two rows of one case
      // share a `ran_at` (a batch inserts all its pending rows in one statement).
      .orderBy(asc(t.evalRuns.caseId), desc(t.evalRuns.ranAt), desc(t.evalRuns.id));
    return new Map(rows.map((r) => [r.caseId, toRun(r)]));
  }

  /** Every row of one batch, oldest first — the input to `scoring.aggregateBatch`. */
  async runsForBatch(
    workspaceId: string,
    batchId: string,
    tx?: EvalExecutor,
  ): Promise<EvalRunDomain[]> {
    const rows = await this.exec(tx)
      .select(RUN_COLUMNS)
      .from(t.evalRuns)
      .innerJoin(t.evalCases, eq(t.evalCases.id, t.evalRuns.caseId))
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalRuns.batchId, batchId)))
      .orderBy(asc(t.evalRuns.ranAt), asc(t.evalRuns.id));
    return rows.map(toRun);
  }

  /**
   * R12 — one agent's run rows, newest first, optionally restricted to one
   * batch. `owner_id` narrows (and is what lets `eval_runs_owner_ran_idx` be
   * used, leftmost prefix), the `eval_cases` join is what makes it tenant-safe.
   */
  async listRunsForAgent(
    workspaceId: string,
    agentId: string,
    opts: { batchId?: string | null; limit?: number } = {},
    tx?: EvalExecutor,
  ): Promise<EvalRunDomain[]> {
    const predicates: SQL[] = [
      eq(t.evalCases.workspaceId, workspaceId),
      eq(t.evalRuns.ownerId, agentId),
    ];
    if (opts.batchId) predicates.push(eq(t.evalRuns.batchId, opts.batchId));

    let query = this.exec(tx)
      .select(RUN_COLUMNS)
      .from(t.evalRuns)
      .innerJoin(t.evalCases, eq(t.evalCases.id, t.evalRuns.caseId))
      .where(and(...predicates))
      .orderBy(desc(t.evalRuns.ranAt), asc(t.evalRuns.id))
      .$dynamic();
    if (opts.limit !== undefined) query = query.limit(opts.limit);
    const rows = await query;
    return rows.map(toRun);
  }

  // =========================================================================
  // Batches — derived, never stored
  // =========================================================================

  /**
   * `GROUP BY batch_id` over one agent's runs, newest batch first.
   *
   * `days` trims by `ran_at`; combined with the `owner_id` equality it is a
   * leftmost-prefix match on `eval_runs_owner_ran_idx (owner_id, ran_at desc)`.
   * `days: null` (or omitted) means "all time" (§8.3).
   */
  async listBatchRowsForAgent(
    workspaceId: string,
    agentId: string,
    opts: { days?: number | null; limit?: number } = {},
    tx?: EvalExecutor,
  ): Promise<EvalBatchRow[]> {
    const predicates: SQL[] = [
      eq(t.evalCases.workspaceId, workspaceId),
      eq(t.agents.workspaceId, workspaceId),
      eq(t.evalRuns.ownerId, agentId),
      isNotNull(t.evalRuns.batchId),
    ];
    if (opts.days != null) {
      predicates.push(gte(t.evalRuns.ranAt, new Date(Date.now() - opts.days * 86_400_000)));
    }
    return this.batchRows(and(...predicates), opts.limit, tx);
  }

  /** `GROUP BY batch_id` across every agent of the workspace, newest first — screen B's "recent eval runs". */
  async listRecentBatchRows(
    workspaceId: string,
    limit: number,
    tx?: EvalExecutor,
  ): Promise<EvalBatchRow[]> {
    return this.batchRows(
      and(
        eq(t.evalCases.workspaceId, workspaceId),
        eq(t.agents.workspaceId, workspaceId),
        isNotNull(t.evalRuns.batchId),
      ),
      limit,
      tx,
    );
  }

  /**
   * The one grouped query behind both batch listings.
   *
   * The `agents` INNER JOIN is deliberate on two counts: it supplies the agent
   * name, and it drops batches whose agent has been deleted — orphaned cases
   * survive by design but stay hidden from the UI. Rows written before
   * migration 0018 have a NULL `batch_id` (and NULL `owner_id`) and are
   * excluded by the caller's `isNotNull` predicate, so they read fine and never
   * pollute a batch (AC-35).
   *
   * Grouping by `agents.id` (a primary key) is what lets `agents.name` be
   * selected without appearing in GROUP BY — Postgres functional dependency.
   */
  private async batchRows(
    where: SQL | undefined,
    limit: number | undefined,
    tx?: EvalExecutor,
  ): Promise<EvalBatchRow[]> {
    let query = this.exec(tx)
      .select({
        batchId: t.evalRuns.batchId,
        agentId: t.agents.id,
        agentName: t.agents.name,
        agentVersion: sql<number | null>`max(${t.evalRuns.agentVersion})::int`,
        ranAt: sql<unknown>`min(${t.evalRuns.ranAt})`,
        lastRanAt: sql<unknown>`max(${t.evalRuns.ranAt})`,
        casesTotal: sql<number>`count(*)::int`,
        pendingCount: sql<number>`(count(*) filter (where ${t.evalRuns.actualOutput} is null))::int`,
        finishedCount: sql<number>`(count(*) filter (where ${t.evalRuns.actualOutput} is not null))::int`,
        latestPendingRanAt: sql<unknown>`max(${t.evalRuns.ranAt}) filter (where ${t.evalRuns.actualOutput} is null)`,
        durationMsTotal: sql<number>`coalesce(sum(${t.evalRuns.durationMs}), 0)::int`,
        costUsdTotal: sql<number | null>`sum(${t.evalRuns.costUsd})::double precision`,
        costMissingCount: sql<number>`(count(*) filter (where ${t.evalRuns.actualOutput} is not null and ${t.evalRuns.costUsd} is null))::int`,
      })
      .from(t.evalRuns)
      .innerJoin(t.evalCases, eq(t.evalCases.id, t.evalRuns.caseId))
      .innerJoin(t.agents, eq(t.agents.id, t.evalRuns.ownerId))
      .where(where)
      .groupBy(t.evalRuns.batchId, t.agents.id)
      .orderBy(desc(sql`min(${t.evalRuns.ranAt})`))
      .$dynamic();
    if (limit !== undefined) query = query.limit(limit);
    const rows = await query;

    return rows.map((r) => ({
      // `batch_id` is NOT NULL for every row this query can return — the
      // callers all add `isNotNull(batchId)` and it is a GROUP BY key.
      batchId: r.batchId as string,
      agentId: r.agentId,
      agentName: r.agentName,
      agentVersion: r.agentVersion,
      ranAt: toDate(r.ranAt),
      lastRanAt: toDate(r.lastRanAt),
      casesTotal: r.casesTotal,
      pendingCount: r.pendingCount,
      finishedCount: r.finishedCount,
      latestPendingRanAt: r.latestPendingRanAt == null ? null : toDate(r.latestPendingRanAt),
      durationMsTotal: r.durationMsTotal,
      costUsdTotal: r.costUsdTotal,
      costMissingCount: r.costMissingCount,
    }));
  }

  /**
   * Case counts per owner across the whole workspace, in ONE query.
   *
   * Screen B renders every agent's card at once; without this the overview
   * would call `listCasesForOwner` per agent and pull every stored diff just to
   * count rows.
   */
  async countCasesByOwner(workspaceId: string, tx?: EvalExecutor): Promise<Map<string, number>> {
    const rows = await this.exec(tx)
      .select({ ownerId: t.evalCases.ownerId, count: sql<number>`count(*)::int` })
      .from(t.evalCases)
      .where(eq(t.evalCases.workspaceId, workspaceId))
      .groupBy(t.evalCases.ownerId);
    return new Map(rows.map((r) => [r.ownerId, r.count]));
  }
}
