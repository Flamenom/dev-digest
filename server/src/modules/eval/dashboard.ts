/**
 * L06 Eval Pipeline — READ-SIDE aggregation: batch records, dashboards,
 * compare and run-all (spec `specs/06-eval-pipeline.md` §5.3, §8, §9.1).
 *
 * APPLICATION ring (onion §7). This file ORCHESTRATES and PROJECTS; it decides
 * nothing that a pure module already decides:
 *
 *   - the three metrics + the batch counts → `scoring.aggregateBatch` (§4.6)
 *   - the alert banner                     → `alerts.buildAlert` (§8.4)
 *   - the system-prompt diff               → `prompt-diff.promptDiff`
 *   - every query                          → `repository.ts` (the only Drizzle file)
 *   - agent rows + version snapshots       → the injected agents repo (onion §9:
 *     never a `modules/agents/**` folder import)
 *
 * The ONE decision that genuinely lives here is the §5.3 batch `status`, and
 * it lives here on purpose: `EvalBatchRow` ships FACTS (`pendingCount`,
 * `latestPendingRanAt`, …) and the stale-window verdict is policy, which the
 * repository must not hold.
 *
 * ---------------------------------------------------------------------------
 * WHY A BATCH'S COUNTERS ARE REBUILT FROM TWO SOURCES
 * ---------------------------------------------------------------------------
 * §4.6's micro-average needs the seven `CaseCounters`. Six of them are stored
 * verbatim in each run's C7 `actual_output` blob. The seventh pair — the two
 * expectation DENOMINATORS (`must_find_total` / `must_not_flag_total`) — is
 * not, and C7 is a frozen contract (D1: no new column, no contract edit). They
 * are therefore read from the case's CURRENT `expected_output`, which the run
 * row is joined to anyway.
 *
 * The consequence, stated plainly rather than hidden: if a case is edited after
 * a batch ran, that batch's recall denominator is recomputed against the new
 * expectation count. This is exactly the hazard §5.2 already models — the run's
 * stored `case_fingerprint` no longer matches, so `compare` reports
 * `comparable: false` and names the case in `changed_case_ids`. Only
 * `must_find_total` feeds a metric (recall); `must_not_flag_total` is
 * informational on C10.
 *
 * ---------------------------------------------------------------------------
 * A RUNNING BATCH REPORTS PARTIAL COUNTS, NEVER PARTIAL METRICS AS FINAL
 * ---------------------------------------------------------------------------
 * Metrics are micro-averaged over FINISHED rows only (§8.1). While
 * `status === 'running'` the client shows a spinner in place of the numbers
 * (AC-22) — the numbers are still returned, honestly labelled by the status,
 * so a poller can watch them converge.
 *
 * `cases_passed / cases_total` is always THAT BATCH's own pass count (§4.6.1,
 * §19.3). It is never recomputed from the live case count.
 */
import {
  AgentVersionConfig,
  EvalActualOutput,
  type EvalAgentDashboard,
  type EvalAgentSummary,
  type EvalAlertDetail,
  type EvalBatchRecord,
  type EvalBatchStarted,
  type EvalBatchStatus,
  type EvalCaseRunRecord,
  type EvalCompare,
  type EvalDashboard,
  type EvalDashboardOverview,
  type EvalPromptDiffLine,
  type EvalRunAllResult,
  type EvalRunRecord,
  type Provider,
} from '@devdigest/shared';
import { AppError, NotFoundError } from '../../platform/errors.js';
import { alertFallbackSentence, buildAlert } from './alerts.js';
import {
  BATCH_STALE_MINUTES,
  DEFAULT_WINDOW_DAYS,
  MAX_CASES_PER_BATCH,
  RECENT_BATCH_LIMIT,
  SPARKLINE_BATCHES,
} from './constants.js';
import { promptDiff } from './prompt-diff.js';
import { aggregateBatch, parseExpectedOutput, type BatchScoreRow } from './scoring.js';
import type { EvalBatchRow, EvalRunDomain } from './types.js';

// ===========================================================================
// Ports — shaped by THIS consumer (onion §3/§4), so the dashboard depends on
// no concrete class and on no `$inferSelect` row type.
// ===========================================================================

/** The part of an agent row the read side needs. A real `AgentRow` satisfies it. */
export interface EvalDashboardAgent {
  id: string;
  name: string;
  provider: Provider;
  model: string;
  version: number;
  enabled: boolean;
}

/** One `agent_versions` snapshot. `configJson` stays `unknown`: it is untyped jsonb (§9.1). */
export interface EvalDashboardAgentVersion {
  configJson: unknown;
}

export interface EvalDashboardAgentsRepo {
  list(workspaceId: string): Promise<EvalDashboardAgent[]>;
  getById(workspaceId: string, id: string): Promise<EvalDashboardAgent | undefined>;
  getVersion(agentId: string, version: number): Promise<EvalDashboardAgentVersion | undefined>;
}

/** The read slice of `EvalRepository`. The real class satisfies it. */
export interface EvalDashboardRepo {
  countCasesByOwner(workspaceId: string): Promise<Map<string, number>>;
  listCasesForOwner(
    workspaceId: string,
    ownerId: string,
  ): Promise<readonly { id: string; expectedOutput: unknown }[]>;
  listBatchRowsForAgent(
    workspaceId: string,
    agentId: string,
    opts: { days?: number | null; limit?: number },
  ): Promise<EvalBatchRow[]>;
  listRunsForAgent(
    workspaceId: string,
    agentId: string,
    opts: { batchId?: string | null; limit?: number },
  ): Promise<EvalRunDomain[]>;
  runsForBatch(workspaceId: string, batchId: string): Promise<EvalRunDomain[]>;
}

/**
 * The runner, as `run-all` uses it.
 *
 * DEVIATION FROM THE PLAN, recorded here so it is discoverable from the code:
 * the plan's deps object is `{ evalRepo, agentsRepo }`, but R17's `run-all`
 * must actually START batches and must know which agents are already running.
 * A structural port is taken rather than the `EvalRunner` class so this file
 * keeps depending on a shape it declares itself.
 */
export interface EvalDashboardRunner {
  startBatch(
    workspaceId: string,
    agentId: string,
    caseIds?: readonly string[] | null,
  ): Promise<EvalBatchStarted>;
  isRunning(agentId: string): boolean;
}

/** The three C23 skip reasons (AC-34), named once so no call site retypes the union. */
export type EvalRunAllSkipReason = EvalRunAllResult['skipped'][number]['reason'];

/** Explicit deps object — built in the composition root, never a `Container`. */
export interface EvalDashboardDeps {
  evalRepo: EvalDashboardRepo;
  agentsRepo: EvalDashboardAgentsRepo;
  runner: EvalDashboardRunner;
}

// ===========================================================================
// Internals
// ===========================================================================

const STALE_MS = BATCH_STALE_MINUTES * 60_000;

/**
 * Row budget for the "runs behind the batch table" fetch.
 *
 * `listRunsForAgent` is limited in ROWS while the batch table is limited in
 * BATCHES, so the budget is the product of the two caps. Both listings are
 * newest-first, so the newest `RECENT_BATCH_LIMIT` batches are always fully
 * covered and truncation can only ever bite batches that are already off the
 * bottom of the table.
 */
const RUN_ROW_BUDGET = RECENT_BATCH_LIMIT * MAX_CASES_PER_BATCH;

/** How many per-case rows the frozen `EvalDashboard.recent_runs` carries. */
const RECENT_RUN_LIMIT = MAX_CASES_PER_BATCH;

/** A batch with no metrics at all — a running batch before its first row lands. */
const ZERO_SCORE_ROW: Omit<BatchScoreRow, 'pass' | 'finished'> = {
  must_find_total: 0,
  must_find_matched: 0,
  must_not_flag_total: 0,
  noise_findings: 0,
  findings_total: 0,
  grounding_kept: 0,
  grounding_total: 0,
};

/** §4.6's vacuous-perfect coercion for the frozen, non-nullable `EvalDashboard.current`. */
function vacuousPerfect(value: number | null | undefined): number {
  return value ?? 1;
}

/**
 * How many expectations each case of one owner currently declares.
 *
 * `null` expected_output (or invalid JSON — the case editor's AC-14 state)
 * yields no entry, so the case contributes no denominator rather than a
 * fabricated zero-expectation one.
 */
function expectationTotals(
  cases: readonly { id: string; expectedOutput: unknown }[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of cases) {
    const parsed = parseExpectedOutput(c.expectedOutput);
    if (parsed) out.set(c.id, parsed.expectations.length);
  }
  return out;
}

/**
 * One persisted run row → one `BatchScoreRow` for `aggregateBatch`.
 *
 * The six stored counters come straight out of the C7 blob (they are the
 * historical truth of what the model actually said); only the expectation
 * denominator is looked up — see the file header for why, and for what happens
 * when the case has since been edited.
 *
 * `pass` is the STORED verdict, never re-derived: §4.6.1 counts what the run
 * recorded, and an errored row must stay `null` (§4.4).
 */
function toScoreRow(run: EvalRunDomain, totals: Map<string, number>): BatchScoreRow {
  if (!run.finished) return { ...ZERO_SCORE_ROW, pass: null, finished: false };

  // `safeParse`, never a cast: `actual_output` is untyped jsonb and rows written
  // before this feature existed can hold any shape. An unparseable blob still
  // counts as a case (passed / failed / errored) but contributes no numerator
  // and no denominator, which is the honest reading of "we cannot tell".
  const blob = EvalActualOutput.safeParse(run.actualOutput);
  if (!blob.success) return { ...ZERO_SCORE_ROW, pass: run.pass, finished: true };

  const data = blob.data;
  const total = totals.get(run.caseId) ?? 0;
  const isMustFind = data.expectation_kind === 'must_find';

  return {
    must_find_total: isMustFind ? total : 0,
    must_find_matched: data.matched_expectations,
    must_not_flag_total: isMustFind ? 0 : total,
    noise_findings: data.noise_findings,
    findings_total: data.findings.length,
    grounding_kept: data.grounding_kept,
    grounding_total: data.grounding_total,
    pass: run.pass,
    finished: true,
  };
}

/**
 * §5.3 — is the batch's newest still-pending row outside the stale window?
 *
 * `latestPendingRanAt` is `max(ran_at) FILTER (pending)`, and `completeRun`
 * never touches `ran_at`, so it is the batch's start time for as long as
 * anything is pending. "≥ 1 pending row inside the window" is therefore exactly
 * "the NEWEST pending row is inside the window".
 */
function pendingIsStale(row: EvalBatchRow, now: number): boolean {
  if (row.pendingCount === 0) return false;
  // Unreachable via SQL (the filter guarantees a timestamp whenever a row is
  // pending); a missing one can only mean a corrupt row, which must not pin a
  // batch in `running` forever.
  if (!row.latestPendingRanAt) return true;
  return now - row.latestPendingRanAt.getTime() > STALE_MS;
}

/**
 * §5.3 — the derived batch status and the errored count that goes with it.
 *
 * `running` while ≥ 1 row is still pending INSIDE the stale window. Once the
 * window passes, those pending rows report as errored and the batch leaves
 * `running` with no reaper job (AC-50) — an API restart mid-batch is therefore
 * self-healing. `failed` means finished and EVERY row errored; anything else is
 * `complete`.
 */
export function deriveBatchStatus(
  row: EvalBatchRow,
  aggErrored: number,
  now: number = Date.now(),
): { status: EvalBatchStatus; casesErrored: number } {
  const stale = pendingIsStale(row, now);
  if (row.pendingCount > 0 && !stale) {
    return { status: 'running', casesErrored: aggErrored };
  }

  // AC-50 — a stale pending row is reported as errored.
  const casesErrored = aggErrored + (stale ? row.pendingCount : 0);
  const status: EvalBatchStatus =
    row.casesTotal > 0 && casesErrored === row.casesTotal ? 'failed' : 'complete';
  return { status, casesErrored };
}

/** Project one batch onto the C10 wire record. */
function toBatchRecord(
  row: EvalBatchRow,
  runs: readonly EvalRunDomain[],
  totals: Map<string, number>,
  now: number,
): EvalBatchRecord {
  const agg = aggregateBatch(runs.map((r) => toScoreRow(r, totals)));
  const { status, casesErrored } = deriveBatchStatus(row, agg.cases_errored, now);

  return {
    batch_id: row.batchId,
    agent_id: row.agentId,
    agent_name: row.agentName,
    agent_version: row.agentVersion,
    ran_at: row.ranAt.toISOString(),
    status,
    recall: agg.recall,
    precision: agg.precision,
    citation_accuracy: agg.citation_accuracy,
    // The SQL `count(*)` is authoritative for `cases_total`: it is the number of
    // pending rows written at batch start (§5.3) and cannot be truncated by a
    // row budget the way the run list can.
    cases_total: row.casesTotal,
    cases_passed: agg.cases_passed,
    cases_failed: agg.cases_failed,
    cases_errored: casesErrored,
    must_find_total: agg.must_find_total,
    must_find_matched: agg.must_find_matched,
    must_not_flag_total: agg.must_not_flag_total,
    noise_findings: agg.noise_findings,
    findings_total: agg.findings_total,
    grounding_kept: agg.grounding_kept,
    grounding_total: agg.grounding_total,
    duration_ms: Math.round(row.durationMsTotal),
    // AC-49 — one finished row with no usage makes the whole batch cost `null`.
    // A partial sum would read as a real, smaller price.
    cost_usd: row.costMissingCount > 0 ? null : row.costUsdTotal,
  };
}

/** Group a flat run list by `batch_id`, preserving each group's order. */
function groupRunsByBatch(runs: readonly EvalRunDomain[]): Map<string, EvalRunDomain[]> {
  const out = new Map<string, EvalRunDomain[]>();
  for (const run of runs) {
    if (!run.batchId) continue; // pre-0018 row: belongs to no batch (§3, AC-35).
    const bucket = out.get(run.batchId);
    if (bucket) bucket.push(run);
    else out.set(run.batchId, [run]);
  }
  return out;
}

/** One `eval_runs` row → the frozen `EvalRunRecord`. */
function toRunRecord(run: EvalRunDomain): EvalRunRecord {
  return {
    id: run.id,
    case_id: run.caseId,
    case_name: run.caseName,
    ran_at: run.ranAt.toISOString(),
    actual_output: run.actualOutput,
    pass: run.pass,
    recall: run.recall,
    precision: run.precision,
    citation_accuracy: run.citationAccuracy,
    duration_ms: run.durationMs,
    cost_usd: run.costUsd,
  };
}

/**
 * Rebuild the SQL `GROUP BY batch_id` header from a batch's own rows.
 *
 * Used by the two single-batch reads (`batchRecord`, `compare`), which start
 * from a `batch_id` rather than from an agent. The repository exposes the
 * grouped query only per-agent / per-workspace, so deriving the same aggregates
 * from the rows already fetched costs one query instead of scanning every batch
 * the agent ever ran. It is plain-data arithmetic over rows, not a second query
 * layer, so it stays inside the application ring.
 */
function synthesizeBatchRow(
  batchId: string,
  agent: EvalDashboardAgent,
  runs: readonly EvalRunDomain[],
): EvalBatchRow {
  let ranAt = runs[0]!.ranAt;
  let lastRanAt = runs[0]!.ranAt;
  let pendingCount = 0;
  let finishedCount = 0;
  let latestPendingRanAt: Date | null = null;
  let durationMsTotal = 0;
  let costUsdTotal: number | null = null;
  let costMissingCount = 0;
  let agentVersion: number | null = null;

  for (const run of runs) {
    if (run.ranAt < ranAt) ranAt = run.ranAt;
    if (run.ranAt > lastRanAt) lastRanAt = run.ranAt;
    if (run.finished) {
      finishedCount += 1;
      if (run.costUsd === null) costMissingCount += 1;
      else costUsdTotal = (costUsdTotal ?? 0) + run.costUsd;
    } else {
      pendingCount += 1;
      if (!latestPendingRanAt || run.ranAt > latestPendingRanAt) latestPendingRanAt = run.ranAt;
    }
    durationMsTotal += run.durationMs ?? 0;
    if (run.agentVersion !== null && (agentVersion === null || run.agentVersion > agentVersion)) {
      agentVersion = run.agentVersion;
    }
  }

  return {
    batchId,
    agentId: agent.id,
    agentName: agent.name,
    agentVersion,
    ranAt,
    lastRanAt,
    casesTotal: runs.length,
    pendingCount,
    finishedCount,
    latestPendingRanAt,
    durationMsTotal,
    costUsdTotal,
    costMissingCount,
  };
}

/**
 * §4.7 / §5.2 — the `(case_id, case_fingerprint)` multiset of one batch.
 *
 * The fingerprint is read out of the C7 blob, which is where the runner wrote
 * it — no extra column (D1). A pending row has no blob, so its fingerprint is
 * `null`: a batch that is still running is not comparable to a finished one,
 * which is the correct answer rather than a convenient one.
 *
 * `insertPendingRuns` writes exactly one row per case, so a plain map is a
 * faithful multiset here.
 */
function fingerprintsOf(runs: readonly EvalRunDomain[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const run of runs) {
    const blob = EvalActualOutput.safeParse(run.actualOutput);
    out.set(run.caseId, blob.success ? blob.data.case_fingerprint : null);
  }
  return out;
}

/** `head − base`, or `null` when either side is `null` (§9.1 — the card renders `—`). */
function metricDelta(head: number | null, base: number | null): number | null {
  return head === null || base === null ? null : head - base;
}

/** What one loaded batch gives the two single-batch reads. */
interface LoadedBatch {
  record: EvalBatchRecord;
  runs: EvalRunDomain[];
  agent: EvalDashboardAgent;
}

// ===========================================================================
// EvalDashboardService
// ===========================================================================

export class EvalDashboardService {
  constructor(private deps: EvalDashboardDeps) {}

  // -------------------------------------------------------------------------
  // R10 — one batch (the polled progress endpoint)
  // -------------------------------------------------------------------------

  /** C10 for one batch. 404 for a missing batch AND for another workspace's — never 403. */
  async batchRecord(workspaceId: string, batchId: string): Promise<EvalBatchRecord> {
    return (await this.loadBatch(workspaceId, batchId)).record;
  }

  /**
   * `runsForBatch` is already tenant-scoped (it joins `eval_cases.workspace_id`),
   * so an empty result is indistinguishable from "another workspace's batch" —
   * which is the point: both answer 404 and neither leaks existence.
   */
  private async loadBatch(workspaceId: string, batchId: string): Promise<LoadedBatch> {
    const runs = await this.deps.evalRepo.runsForBatch(workspaceId, batchId);
    if (runs.length === 0) throw new NotFoundError('Eval batch not found');

    // `eval_runs.owner_id` is a denormalized AGENT id and NEVER a tenancy filter
    // (§3). Tenancy was already settled by the `eval_cases` join above; this
    // only names which agent the batch belongs to.
    const agentId = runs.find((r) => r.ownerId !== null)?.ownerId;
    if (!agentId) throw new NotFoundError('Eval batch not found');

    const agent = await this.deps.agentsRepo.getById(workspaceId, agentId);
    // A deleted agent hides its batches, exactly as the grouped query's INNER
    // JOIN on `agents` does — orphaned cases survive but stay out of the UI.
    if (!agent) throw new NotFoundError('Eval batch not found');

    const totals = expectationTotals(
      await this.deps.evalRepo.listCasesForOwner(workspaceId, agentId),
    );
    const row = synthesizeBatchRow(batchId, agent, runs);
    return { record: toBatchRecord(row, runs, totals, Date.now()), runs, agent };
  }

  // -------------------------------------------------------------------------
  // R11 — screen B, every agent at a glance
  // -------------------------------------------------------------------------

  /**
   * C14 — one summary per agent (§8.2) plus the workspace's most recent batches.
   *
   * `last_batch` is the LATEST COMPLETE batch only, not a rolling window: the
   * question the harness answers is "did the change I just made help", and a
   * rolling mean blurs agent versions and case-set revisions together (AC-24).
   *
   * `recent_batches` is assembled from the per-agent pass rather than from a
   * second grouped query. Each agent contributes its newest
   * `RECENT_BATCH_LIMIT` batches, so the union necessarily contains the
   * workspace's newest `RECENT_BATCH_LIMIT` — and every one of them already
   * carries computed metrics, which a header-only query could not supply.
   */
  async overview(workspaceId: string): Promise<EvalDashboardOverview> {
    const now = Date.now();
    const [agents, caseCounts] = await Promise.all([
      this.deps.agentsRepo.list(workspaceId),
      this.deps.evalRepo.countCasesByOwner(workspaceId),
    ]);

    const summaries: EvalAgentSummary[] = [];
    const allBatches: EvalBatchRecord[] = [];

    for (const agent of agents) {
      const records = await this.batchRecordsForAgent(workspaceId, agent.id, null, now);
      allBatches.push(...records);

      const complete = records.filter((b) => b.status === 'complete');
      summaries.push({
        agent_id: agent.id,
        name: agent.name,
        model: agent.model,
        version: agent.version,
        enabled: agent.enabled,
        cases_total: caseCounts.get(agent.id) ?? 0,
        last_batch: complete[0] ?? null,
        // §8.2 — recall of the last `SPARKLINE_BATCHES` complete batches,
        // oldest→newest, `null` metrics skipped (never coerced to 0, which
        // would draw a cliff where there is simply no measurement).
        sparkline: complete
          .flatMap((b) => (b.recall === null ? [] : [b.recall]))
          .slice(0, SPARKLINE_BATCHES)
          .reverse(),
      });
    }

    allBatches.sort((a, b) => b.ran_at.localeCompare(a.ran_at));
    return { agents: summaries, recent_batches: allBatches.slice(0, RECENT_BATCH_LIMIT) };
  }

  // -------------------------------------------------------------------------
  // R12 — the per-case run rows behind a batch
  // -------------------------------------------------------------------------

  /**
   * C8 — one agent's run rows, newest first, optionally narrowed to one batch.
   *
   * A projection, not an aggregation: screen E flips each case row to its
   * result as the batch progresses, so these rows must stay individual. The
   * three C8 extensions over the frozen `EvalRunRecord` are all nullish because
   * rows written before migration 0018 still read (§3), and `error` is read out
   * of the C7 blob with `safeParse` — never a cast, since `actual_output` is
   * untyped jsonb that can hold any historical shape.
   *
   * 404 for a missing AND for a foreign agent, never 403 (A01).
   */
  async runsForAgent(
    workspaceId: string,
    agentId: string,
    opts: { batchId?: string | null; limit?: number } = {},
  ): Promise<EvalCaseRunRecord[]> {
    const agent = await this.deps.agentsRepo.getById(workspaceId, agentId);
    if (!agent) throw new NotFoundError('Agent not found');

    const runs = await this.deps.evalRepo.listRunsForAgent(workspaceId, agentId, opts);
    return runs.map((run) => {
      const blob = EvalActualOutput.safeParse(run.actualOutput);
      return {
        ...toRunRecord(run),
        batch_id: run.batchId,
        agent_version: run.agentVersion,
        error: blob.success ? blob.data.error ?? null : null,
      };
    });
  }

  // -------------------------------------------------------------------------
  // R13 — screen C, one agent inside a date window
  // -------------------------------------------------------------------------

  /**
   * C17 — the windowed per-agent dashboard (§8.3).
   *
   * `days` filters EVERYTHING together — the batch table, the trend, `current`
   * and `delta` — because `current` must always agree with the table's top row.
   * `null` means "all time". When the window holds no complete batch the reply
   * carries an empty trend and a zero-trace `current`, which is the client's
   * empty state (AC-23); stale numbers from outside the window are never shown.
   *
   * The frozen `EvalDashboard` is filled under the plan's C3/C4 conventions:
   *  - C3 `delta[m] = (head[m] ?? 1) − (base[m] ?? 1)`, and `0` when the window
   *    holds fewer than two complete batches. The honest, nullable deltas live
   *    on `EvalCompare.deltas` and on the C16 alert, which is what the UI reads.
   *  - C4 a trend point is OMITTED ENTIRELY when any of its three metrics is
   *    `null`, rather than coerced — `batches` still lists that batch with its
   *    honest nulls, so nothing disappears from the page.
   */
  async agentDashboard(
    workspaceId: string,
    agentId: string,
    days: number | null = DEFAULT_WINDOW_DAYS,
  ): Promise<EvalAgentDashboard> {
    const now = Date.now();
    const agent = await this.deps.agentsRepo.getById(workspaceId, agentId);
    if (!agent) throw new NotFoundError('Agent not found');

    const [caseCounts, batches, runs] = await Promise.all([
      this.deps.evalRepo.countCasesByOwner(workspaceId),
      this.deps.evalRepo.listBatchRowsForAgent(workspaceId, agentId, {
        days,
        limit: RECENT_BATCH_LIMIT,
      }),
      this.deps.evalRepo.listRunsForAgent(workspaceId, agentId, { limit: RUN_ROW_BUDGET }),
    ]);
    const totals = expectationTotals(
      await this.deps.evalRepo.listCasesForOwner(workspaceId, agentId),
    );

    const byBatch = groupRunsByBatch(runs);
    const records = batches.map((row) =>
      toBatchRecord(row, byBatch.get(row.batchId) ?? [], totals, now),
    );

    // Newest-first, so `[0]` is the head and `[1]` the base (§8.4 inputs).
    const complete = records.filter((b) => b.status === 'complete');
    const head = complete[0] ?? null;
    const base = complete[1] ?? null;

    const detail = buildAlert(head, base);
    const dashboard = this.frozenDashboard(
      agentId,
      caseCounts.get(agentId) ?? 0,
      complete,
      head,
      base,
      detail,
      byBatch,
      batches,
    );

    return {
      agent: {
        id: agent.id,
        name: agent.name,
        model: agent.model,
        version: agent.version,
        provider: agent.provider,
      },
      window_days: days,
      dashboard,
      batches: records,
      alert: detail,
    };
  }

  /** Fill the FROZEN `EvalDashboard` (C3/C4). Its coercions never render as a score (AC-21). */
  private frozenDashboard(
    agentId: string,
    casesTotal: number,
    complete: readonly EvalBatchRecord[],
    head: EvalBatchRecord | null,
    base: EvalBatchRecord | null,
    detail: EvalAlertDetail | null,
    byBatch: Map<string, EvalRunDomain[]>,
    windowRows: readonly EvalBatchRow[],
  ): EvalDashboard {
    // C3 — `0` rather than a coerced difference when there is nothing to compare.
    const delta =
      head && base
        ? {
            recall: vacuousPerfect(head.recall) - vacuousPerfect(base.recall),
            precision: vacuousPerfect(head.precision) - vacuousPerfect(base.precision),
            citation_accuracy:
              vacuousPerfect(head.citation_accuracy) - vacuousPerfect(base.citation_accuracy),
          }
        : { recall: 0, precision: 0, citation_accuracy: 0 };

    const recentRuns = windowRows
      .flatMap((row) => byBatch.get(row.batchId) ?? [])
      .slice(0, RECENT_RUN_LIMIT)
      .map(toRunRecord);

    return {
      owner_kind: 'agent',
      owner_id: agentId,
      cases_total: casesTotal,
      current: {
        recall: vacuousPerfect(head?.recall),
        precision: vacuousPerfect(head?.precision),
        citation_accuracy: vacuousPerfect(head?.citation_accuracy),
        // §4.6 — `traces_*` ARE the batch's case counts; `0/0` is the AC-23
        // empty-window state, not a measured perfect score.
        traces_passed: head?.cases_passed ?? 0,
        traces_total: head?.cases_total ?? 0,
        cost_usd: head?.cost_usd ?? null,
      },
      delta,
      // C4 — chronological (oldest→newest); a point with any null metric is
      // dropped whole rather than coerced, so the chart never draws a fake 1.0.
      trend: complete
        .slice()
        .reverse()
        .flatMap((b) =>
          b.recall === null || b.precision === null || b.citation_accuracy === null
            ? []
            : [
                {
                  ran_at: b.ran_at,
                  recall: b.recall,
                  precision: b.precision,
                  citation_accuracy: b.citation_accuracy,
                  pass_rate: b.cases_total === 0 ? 0 : b.cases_passed / b.cases_total,
                  cost_usd: b.cost_usd,
                },
              ],
        ),
      recent_runs: recentRuns,
      // The frozen field is a plain English string. The client ignores it and
      // renders the structured C16 detail through next-intl (§8.4, AC-44).
      alert: detail ? alertFallbackSentence(detail) : null,
    };
  }

  // -------------------------------------------------------------------------
  // R16 — compare two batches of the same agent
  // -------------------------------------------------------------------------

  /**
   * C19 (§9.1). 422 `same_batch` when the two ids are equal and 422
   * `cross_agent_compare` when they belong to different agents — a cross-agent
   * number compares different case sets and makes the prompt diff meaningless,
   * so it is refused rather than rendered with a caveat.
   */
  async compare(workspaceId: string, baseId: string, headId: string): Promise<EvalCompare> {
    if (baseId === headId) {
      throw new AppError('same_batch', 'Select two different batches to compare', 422);
    }

    const [baseBatch, headBatch] = await Promise.all([
      this.loadBatch(workspaceId, baseId),
      this.loadBatch(workspaceId, headId),
    ]);

    if (baseBatch.agent.id !== headBatch.agent.id) {
      throw new AppError(
        'cross_agent_compare',
        'Batches of two different agents cannot be compared',
        422,
        { base_agent_id: baseBatch.agent.id, head_agent_id: headBatch.agent.id },
      );
    }

    const base = baseBatch.record;
    const head = headBatch.record;
    const { comparable, changed_case_ids } = compareCaseSets(baseBatch.runs, headBatch.runs);
    const prompt = await this.promptDiffFor(baseBatch.agent.id, base, head);

    return {
      base,
      head,
      deltas: {
        recall: metricDelta(head.recall, base.recall),
        precision: metricDelta(head.precision, base.precision),
        citation_accuracy: metricDelta(head.citation_accuracy, base.citation_accuracy),
        // §9.1 — a cost delta against an unknown is not a number; the client
        // omits the COST card entirely when this is `null`.
        cost_usd: metricDelta(head.cost_usd, base.cost_usd),
      },
      comparable,
      changed_case_ids,
      prompt_diff: prompt.lines,
      prompt_diff_available: prompt.available,
      // What "revert to the older configuration" would promote. `null` on a
      // pre-0018 row, which carries no `agent_version` to promote (§3).
      promote_target_version: base.agent_version ?? null,
    };
  }

  /**
   * The line-level `system_prompt` diff of the two batches' snapshotted versions.
   *
   * `agent_versions.config_json` is untyped `jsonb` and is NEVER cast: it is
   * `safeParse`d with `AgentVersionConfig`, and a snapshot that fails to parse
   * is treated exactly like a missing one — `prompt_diff_available: false`, so
   * the section renders an explanatory empty state instead of a fake diff
   * (§9.1).
   */
  private async promptDiffFor(
    agentId: string,
    base: EvalBatchRecord,
    head: EvalBatchRecord,
  ): Promise<{ lines: EvalPromptDiffLine[]; available: boolean }> {
    const baseVersion = base.agent_version;
    const headVersion = head.agent_version;
    // A pre-0018 row has no snapshotted version, so there is nothing to diff.
    if (baseVersion == null || headVersion == null) return { lines: [], available: false };

    const [baseSnap, headSnap] = await Promise.all([
      this.deps.agentsRepo.getVersion(agentId, baseVersion),
      this.deps.agentsRepo.getVersion(agentId, headVersion),
    ]);
    const basePrompt = systemPromptOf(baseSnap);
    const headPrompt = systemPromptOf(headSnap);
    if (basePrompt === null || headPrompt === null) return { lines: [], available: false };

    return { lines: promptDiff(basePrompt, headPrompt), available: true };
  }

  // -------------------------------------------------------------------------
  // R17 — run every eligible agent
  // -------------------------------------------------------------------------

  /**
   * C23 (AC-34) — one batch per ENABLED agent that has ≥ 1 case; every other
   * agent comes back with a reason.
   *
   * Reasons are checked in a fixed order, and the order is the answer to "which
   * reason wins": `disabled` first, because a disabled agent is out of scope
   * whatever else is true of it; then `already_running`, because that is a
   * temporary state of an otherwise eligible agent; then `no_cases`.
   *
   * Batches are STARTED sequentially but EXECUTE in parallel: `startBatch`
   * returns as soon as the pending rows are written (§5.3), so awaiting each in
   * turn costs one insert per agent and still leaves every batch running
   * concurrently (Q3). The per-agent `AppError` catch closes the race between
   * the `isRunning` / case-count checks and the runner's own claim.
   */
  async runAll(workspaceId: string): Promise<EvalRunAllResult> {
    const [agents, caseCounts] = await Promise.all([
      this.deps.agentsRepo.list(workspaceId),
      this.deps.evalRepo.countCasesByOwner(workspaceId),
    ]);

    const started: EvalBatchStarted[] = [];
    const skipped: EvalRunAllResult['skipped'] = [];
    const skip = (agent: EvalDashboardAgent, reason: EvalRunAllSkipReason) => {
      skipped.push({ agent_id: agent.id, agent_name: agent.name, reason });
    };

    for (const agent of agents) {
      if (!agent.enabled) {
        skip(agent, 'disabled');
        continue;
      }
      if (this.deps.runner.isRunning(agent.id)) {
        skip(agent, 'already_running');
        continue;
      }
      if ((caseCounts.get(agent.id) ?? 0) === 0) {
        skip(agent, 'no_cases');
        continue;
      }

      try {
        started.push(await this.deps.runner.startBatch(workspaceId, agent.id));
      } catch (err) {
        const reason = runAllSkipReason(err);
        // An unexpected failure is NOT silently turned into a skip reason:
        // run-all is a bulk action and swallowing a real error would report a
        // green result over a broken one.
        if (!reason) throw err;
        skip(agent, reason);
      }
    }

    return { started, skipped };
  }

  // -------------------------------------------------------------------------
  // Shared read path
  // -------------------------------------------------------------------------

  /** Every batch of one agent inside `days`, newest first, with metrics attached. */
  private async batchRecordsForAgent(
    workspaceId: string,
    agentId: string,
    days: number | null,
    now: number,
  ): Promise<EvalBatchRecord[]> {
    const batches = await this.deps.evalRepo.listBatchRowsForAgent(workspaceId, agentId, {
      days,
      limit: RECENT_BATCH_LIMIT,
    });
    if (batches.length === 0) return [];

    const [runs, cases] = await Promise.all([
      this.deps.evalRepo.listRunsForAgent(workspaceId, agentId, { limit: RUN_ROW_BUDGET }),
      this.deps.evalRepo.listCasesForOwner(workspaceId, agentId),
    ]);
    const totals = expectationTotals(cases);
    const byBatch = groupRunsByBatch(runs);

    return batches.map((row) => toBatchRecord(row, byBatch.get(row.batchId) ?? [], totals, now));
  }
}

// ===========================================================================
// Free helpers used by the class above
// ===========================================================================

/**
 * §5.2 — are the two batches' `(case_id, case_fingerprint)` multisets equal?
 *
 * `changed_case_ids` names every case that is on one side only, or on both
 * sides with a different fingerprint (i.e. edited between the two runs). Sorted
 * so the response is stable and diffable.
 */
function compareCaseSets(
  baseRuns: readonly EvalRunDomain[],
  headRuns: readonly EvalRunDomain[],
): { comparable: boolean; changed_case_ids: string[] } {
  const baseFp = fingerprintsOf(baseRuns);
  const headFp = fingerprintsOf(headRuns);

  const changed = new Set<string>();
  for (const [caseId, fp] of baseFp) {
    if (!headFp.has(caseId) || headFp.get(caseId) !== fp) changed.add(caseId);
  }
  for (const caseId of headFp.keys()) {
    if (!baseFp.has(caseId)) changed.add(caseId);
  }

  return { comparable: changed.size === 0, changed_case_ids: [...changed].sort() };
}

/** `config_json.system_prompt`, or `null` when the snapshot is missing or does not parse. */
function systemPromptOf(snapshot: EvalDashboardAgentVersion | undefined): string | null {
  if (!snapshot) return null;
  const parsed = AgentVersionConfig.safeParse(snapshot.configJson);
  return parsed.success ? parsed.data.system_prompt : null;
}

/**
 * Map the runner's own 409/422 codes onto a C23 skip reason.
 *
 * Matched by CODE, never by `instanceof` on a foreign class and never on the
 * message text; anything else returns `undefined` so the caller rethrows.
 */
function runAllSkipReason(err: unknown): EvalRunAllSkipReason | undefined {
  const code = err instanceof AppError ? err.code : undefined;
  if (code === 'batch_already_running') return 'already_running';
  if (code === 'no_cases') return 'no_cases';
  return undefined;
}
