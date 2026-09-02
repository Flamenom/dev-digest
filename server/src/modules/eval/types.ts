/**
 * L06 Eval Pipeline — the slice's DOMAIN shapes.
 *
 * Why this file exists (onion §5, spec §14): `repository.ts` is the only file
 * in `modules/eval/` that may touch Drizzle, and **no `$inferSelect` row type
 * may cross a service signature**. Exposing a row type would make the physical
 * table layout part of the slice's internal API, so every migration would be a
 * breaking change for `service.ts` / `runner.ts` / `dashboard.ts`. The
 * repository therefore maps row → the shapes below at its boundary, and the
 * three application files import ONLY from here.
 *
 * These are internal domain shapes, deliberately camelCase and `Date`-typed —
 * they are NOT the wire contracts. The snake_case, ISO-string wire shapes are
 * `EvalCaseRecord` / `EvalCaseRunRecord` / `EvalBatchRecord` (C6 / C8 / C10) in
 * `@devdigest/shared`, and projecting onto them is the application ring's job.
 */
import type { Db } from '../../db/client.js';
import type { EvalOwnerKind } from '@devdigest/shared';

// ===========================================================================
// Executor — every repository method takes an optional `tx`
// ===========================================================================

/**
 * The transaction handle Drizzle hands to a `db.transaction(async (tx) => …)`
 * callback, derived from `Db` so it cannot drift from the client type.
 */
export type EvalTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * What a repository method actually runs against. Transaction boundaries belong
 * to the APPLICATION ring (onion §5): a service passes its `tx` so several
 * repository calls compose into one `db.transaction`, and the repository never
 * opens a transaction of its own.
 */
export type EvalExecutor = Db | EvalTx;

// ===========================================================================
// Cases
// ===========================================================================

/**
 * One `eval_cases` row as the slice sees it.
 *
 * `inputDiff` is `string`, never `null`: the column is nullable but
 * `EvalCase.input_diff` (frozen contract) is not, so the repository maps
 * `null → ''` here (plan §Concerns C6). An empty diff is a legal state — the
 * runner reports it as `empty_diff` before any model call (AC-47) rather than
 * crashing.
 *
 * The three jsonb blobs stay `unknown` ON PURPOSE. They are untyped columns
 * that can hold anything written before this feature existed; narrowing them
 * with a cast at the repository boundary would be a lie. The application ring
 * `safeParse`s them with `EvalExpectedOutput` (C3) / `EvalPrMeta` (C4) — the
 * trust boundary, not the storage layer, decides what is valid.
 */
export interface EvalCaseDomain {
  id: string;
  workspaceId: string;
  ownerKind: EvalOwnerKind;
  ownerId: string;
  name: string;
  inputDiff: string;
  inputFiles: unknown;
  inputMeta: unknown;
  expectedOutput: unknown;
  notes: string | null;
  /** Soft provenance pointer — no FK, so a dangling value is legal (§3). */
  sourceFindingId: string | null;
}

/** What `insertCase` needs. `workspaceId` is mandatory: there is no "current tenant" ambient state. */
export interface NewEvalCase {
  workspaceId: string;
  ownerKind: EvalOwnerKind;
  ownerId: string;
  name: string;
  inputDiff: string;
  inputFiles?: unknown;
  inputMeta?: unknown;
  expectedOutput?: unknown;
  notes?: string | null;
  sourceFindingId?: string | null;
}

/** Patch for `updateCase`. Only the keys present are written (no body spreading). */
export interface EvalCasePatch {
  name?: string;
  inputDiff?: string;
  inputFiles?: unknown;
  inputMeta?: unknown;
  expectedOutput?: unknown;
  notes?: string | null;
}

/**
 * Result of the guarded delete (R7 / AC-12). The repository reports facts; the
 * service turns them into HTTP: `!found` → 404 (never 403), `found && !deleted`
 * → 409 `case_has_runs` carrying `runCount`, `deleted` → 200.
 */
export interface EvalCaseDeleteResult {
  found: boolean;
  deleted: boolean;
  /** How many `eval_runs` rows the delete would cascade away. */
  runCount: number;
}

/** C22 `EvalCaseLink`, before the wire projection: which findings of a PR already have a case. */
export interface EvalCaseLinkRow {
  findingId: string;
  caseId: string;
  caseName: string;
}

// ===========================================================================
// Runs
// ===========================================================================

/**
 * One `eval_runs` row, with its case's name joined in.
 *
 * `pass === null` is ambiguous by design and MUST be disambiguated by
 * `actualOutput` (§5.3):
 *   - `actualOutput === null` → the row is **pending** (inserted up front at
 *     batch start, not executed yet);
 *   - `actualOutput !== null` → the row **finished**; it errored if the C7 blob
 *     carries an `error` field.
 * `finished` below is that check, precomputed so no caller re-derives it wrong.
 */
export interface EvalRunDomain {
  id: string;
  caseId: string;
  caseName: string;
  ranAt: Date;
  actualOutput: unknown;
  /** `actualOutput !== null` — the row has been executed (passed, failed or errored). */
  finished: boolean;
  pass: boolean | null;
  recall: number | null;
  precision: number | null;
  citationAccuracy: number | null;
  durationMs: number | null;
  costUsd: number | null;
  batchId: string | null;
  agentVersion: number | null;
  /** Denormalized AGENT id — never a tenancy filter (§3). */
  ownerId: string | null;
}

/** The pending row minted for one case at batch start (§5.3). */
export interface EvalPendingRun {
  runId: string;
  caseId: string;
}

/** What `completeRun` writes when a case finishes (or errors). */
export interface EvalRunCompletion {
  /**
   * The C7 `EvalActualOutput` blob. Never `null` — writing `null` would put the
   * row back into the *pending* state and the batch would never leave `running`.
   */
  actualOutput: unknown;
  /** `null` = errored; an infrastructure failure is never counted as a fail (§4.4). */
  pass: boolean | null;
  recall: number | null;
  precision: number | null;
  citationAccuracy: number | null;
  durationMs: number | null;
  /** `null` when the provider reported no usage (AC-49) — not `0`. */
  costUsd: number | null;
}

// ===========================================================================
// Batches — DERIVED by grouping `eval_runs` on `batch_id` (no header table, §3)
// ===========================================================================

/**
 * The SQL-derivable header of one batch. Everything here is a `GROUP BY
 * batch_id` aggregate; the METRICS are deliberately absent, because §4.6 is
 * pure code over each row's C7 blob (`scoring.aggregateBatch`), not SQL. Pair
 * this with `runsForBatch` / `listRunsForAgent` when you need numbers.
 *
 * `status` (C9) is likewise NOT here: it is a policy decision the application
 * ring makes from `pendingCount` + `latestPendingRanAt` + `BATCH_STALE_MINUTES`
 * (§5.3, AC-50). The repository ships the facts, not the verdict.
 */
export interface EvalBatchRow {
  batchId: string;
  /** `eval_runs.owner_id` of the batch — the agent it ran; the join to `agents` is what proves it exists. */
  agentId: string;
  agentName: string;
  agentVersion: number | null;
  /** Batch start = `min(ran_at)`: the pending rows are all inserted up front (§5.3). */
  ranAt: Date;
  /** `max(ran_at)` over the batch. */
  lastRanAt: Date;
  /** Rows in the batch = the number of cases selected at start (§5.3 — this is what makes `cases_total` knowable). */
  casesTotal: number;
  /** Rows still `actual_output IS NULL`. */
  pendingCount: number;
  /** Rows that finished (passed, failed or errored). */
  finishedCount: number;
  /** `max(ran_at)` among PENDING rows, `null` when nothing is pending — the input to the §5.3 stale check. */
  latestPendingRanAt: Date | null;
  /** `sum(duration_ms)` over the batch, `0` when nothing reported one. */
  durationMsTotal: number;
  /** `sum(cost_usd)` over the rows that reported one; `null` when none did. */
  costUsdTotal: number | null;
  /** Finished rows with `cost_usd IS NULL` — lets the caller keep the batch cost `null` (AC-49) instead of under-reporting a sum. */
  costMissingCount: number;
}

// ===========================================================================
// Domain error signals
// ===========================================================================

/**
 * The `eval_cases_source_finding_uq` unique index fired: another case already
 * points at this finding.
 *
 * Translated at the repository boundary (onion §5) so no `postgres` error
 * object ever escapes the data layer. It is NOT an `AppError`: the service does
 * not turn it into an HTTP error but into the IDEMPOTENT path — re-fetch the
 * existing case and answer 200 (R1, AC-9). It exists for the race the
 * read-then-write check cannot close.
 */
export class DuplicateSourceFindingError extends Error {
  constructor(public readonly sourceFindingId: string) {
    super(`An eval case already exists for finding ${sourceFindingId}`);
    this.name = 'DuplicateSourceFindingError';
  }
}
