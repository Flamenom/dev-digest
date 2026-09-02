/**
 * L06 Eval Pipeline — tuning constants (spec `specs/06-eval-pipeline.md` §5.3,
 * §8.2, §8.3, §8.4).
 *
 * PURE MODULE. No imports at all: this file is inside the
 * `eval-scoring-purity` dependency-cruiser rule's `from` pattern, so it must
 * never reach `db/`, `adapters/`, `fastify` or the composition root.
 *
 * ---------------------------------------------------------------------------
 * Every value below is a PROPOSED, UNMEASURED bound (plan Q1/Q2).
 * ---------------------------------------------------------------------------
 * None of them was derived from a measurement — they are the spec's opening
 * offers, gathered here so that re-tuning after the first real batch is a
 * one-line edit and never a code change. No code shape depends on any value.
 * Each constant carries the observation that should trigger a re-tune.
 */

// --- Batch execution (§5.3) -------------------------------------------------

/**
 * Cases executed in parallel within ONE batch (`p-queue` concurrency).
 * Deliberately low: every case is an LLM call, and the bound exists to respect
 * provider rate limits rather than to go fast.
 *
 * PROPOSED, UNMEASURED (Q1). This is per-batch, not global — `run-all` starts
 * every eligible agent in parallel, so N concurrent batches issue up to
 * `N × EVAL_CONCURRENCY` calls. An operator on a low provider tier drops this
 * to 1 and gets N concurrent calls instead of 2N without touching `run-all`.
 * Re-tune only if a provider rate-limit error is actually observed.
 */
export const EVAL_CONCURRENCY = 2;

/**
 * Hard cap on cases per batch; above it the request is rejected 422
 * `too_many_cases`. Together with the one-in-flight-batch-per-agent lock this
 * is the ONLY spend bound on the three endpoints that cost money (R8/R9/R17).
 *
 * PROPOSED, UNMEASURED (Q1). Confirm against a real batch's cost and wall
 * clock before raising it.
 */
export const MAX_CASES_PER_BATCH = 50;

/**
 * Per-case timeout. A case that exceeds it is recorded as errored
 * (`pass = null`) and the batch continues — an infrastructure failure is never
 * an agent regression (§4.4).
 *
 * PROPOSED, UNMEASURED (Q1).
 */
export const EVAL_CASE_TIMEOUT_MS = 120_000;

/**
 * Whole-batch wall clock. When it elapses, rows still pending are marked
 * errored so the batch can leave `running`.
 *
 * PROPOSED, UNMEASURED (Q1). Note the interaction: 50 cases at concurrency 2
 * and 120 s each is a 50-minute worst case, i.e. this cap can fire before the
 * queue drains. That is intentional (a stuck batch must terminate), but if
 * legitimate full batches start getting truncated, raise this rather than
 * lowering `EVAL_CASE_TIMEOUT_MS`.
 */
export const BATCH_WALL_CLOCK_MS = 15 * 60_000;

/**
 * Staleness window for DERIVED batch status (§5.3). A batch is `running` only
 * while ≥1 row is still pending AND its `ran_at` is inside this window; older
 * pending rows report as errored (`stale`). This is what makes an API restart
 * mid-batch self-healing with no reaper job.
 *
 * PROPOSED, UNMEASURED (Q1). Must stay comfortably above
 * `BATCH_WALL_CLOCK_MS`; at 15 min vs 20 min the margin is 5 minutes.
 */
export const BATCH_STALE_MINUTES = 20;

// --- Alerting (§8.4) --------------------------------------------------------

/**
 * A metric move is *significant* iff `|delta_pts| >= ALERT_THRESHOLD_PTS`,
 * where `delta_pts = round((head − base) × 100)` half away from zero.
 *
 * PROPOSED, UNMEASURED (Q2). 2 pts reproduces the design's own banner. On a
 * ~10-case set, run-to-run noise plausibly exceeds 2 pts; if the banner starts
 * firing on noise, raise to 3–5. No code shape depends on the value.
 */
export const ALERT_THRESHOLD_PTS = 2;

// --- Dashboard read limits (§8.2, §8.3) -------------------------------------

/**
 * Points in an agent card's recall sparkline: the last N COMPLETE batches,
 * oldest → newest, `null` metrics skipped (§8.2).
 *
 * PROPOSED, UNMEASURED (Q1).
 */
export const SPARKLINE_BATCHES = 10;

/**
 * Rows in the "recent eval runs" tables (`/evals` overview and the per-agent
 * batch table).
 *
 * PROPOSED, UNMEASURED (Q1).
 */
export const RECENT_BATCH_LIMIT = 20;

/**
 * Default value of the `?days=` window on the per-agent dashboard (§8.3).
 * The control offers 7 / 30 / 90 / all.
 *
 * PROPOSED, UNMEASURED (Q1).
 */
export const DEFAULT_WINDOW_DAYS = 30;
