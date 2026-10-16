/**
 * L06 Eval Pipeline HTTP module (spec `specs/06-eval-pipeline.md` §6).
 *
 *   R1  POST   /findings/:id/eval-case        → EvalCaseRecord      201 new · 200 idempotent re-click
 *   R1b GET    /findings/:id/eval-case-draft  → EvalCaseDraft       200 · 404 · 409 (composes, never writes)
 *   R2  GET    /pulls/:id/eval-cases          → EvalCaseLink[]      200 · 404 PR
 *   R3  GET    /agents/:id/eval-cases         → EvalCaseRecord[]    200 · 404 agent
 *   R4  POST   /eval-cases                    → EvalCaseRecord      201 · 404 owner · 422
 *   R5  GET    /eval-cases/:id                → EvalCaseRecord      200 · 404
 *   R6  PUT    /eval-cases/:id                → EvalCaseRecord      200 · 404 · 422
 *   R7  DELETE /eval-cases/:id[?force=true]   → { deleted: true }   200 · 404 · 409 case_has_runs
 *   R8b POST   /agents/:id/eval-cases/run-draft → EvalRunResult   200 · 404 · 422 (runs, never writes)
 *   R8  POST   /eval-cases/:id/run            → EvalRunResult       200 · 404 · 409 · 422 · 502
 *   R9  POST   /agents/:id/eval-runs          → EvalBatchStarted    202 · 404 · 409 · 422
 *   R10 GET    /evals/batches/:batchId        → EvalBatchRecord     200 · 404
 *   R11 GET    /agents/:id/eval-batches       → EvalBatchRecord[]   200 · 404
 *   R12 GET    /agents/:id/eval-runs          → EvalCaseRunRecord[] 200 · 404
 *   R13 GET    /agents/:id/eval-dashboard     → EvalAgentDashboard  200 · 404
 *   R15 GET    /evals/dashboard               → EvalDashboardOverview 200
 *   R16 GET    /evals/compare?base=&head=     → EvalCompare         200 · 404 · 422
 *   R17 POST   /evals/run-all                 → EvalRunAllResult    202
 *
 * R14 (`POST /agents/:id/versions/:version/promote`) deliberately lives in
 * `modules/agents/routes.ts` — it re-applies a config through the SAME
 * `update` → `isConfigChange` → `snapshotVersion` path as `PUT /agents/:id`,
 * and duplicating the version-bump semantics here is exactly how the two would
 * drift (§9.2).
 *
 * PRESENTATION RING ONLY (onion §4). Every handler is: resolve tenancy →
 * translate the request → ONE application call → set a status code. There is no
 * business branching here; the 404/409/422 taxonomy is raised by the
 * application ring as `AppError`s and rendered by the global error handler.
 *
 * TENANCY (A01). `getContext(container, req)` runs on EVERY route, including
 * the two addressed by a `/findings` or `/pulls` id — those rows belong to
 * other slices, so the eval service asserts the workspace on them explicitly.
 * A row of another workspace is always **404, never 403**: the two must be
 * indistinguishable or existence leaks.
 *
 * ROUTE-COLLISION NOTE (C8). `POST /findings/:id/eval-case` sits beside
 * `modules/reviews/routes.ts`'s `/findings/:id/${action}` loop. Those are
 * STATIC third segments (`accept`, `dismiss`), not a parametric `:action`, so
 * find-my-way routes them separately and there is no collision today. A
 * refactor to `:action` would silently swallow this route — `routes-smoke`
 * carries the regression test for it.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  EvalBatchRunInput,
  EvalCaseFromFindingInput,
  EvalCaseInput,
  EvalDraftRunInput,
  EvalExpectedOutput,
} from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { ValidationError } from '../../platform/errors.js';
import { DEFAULT_WINDOW_DAYS } from './constants.js';

/** `/evals/batches/:batchId` — a batch id is the uuid minted at batch start. */
const BatchParams = z.object({ batchId: z.string().uuid() });

/**
 * `?days=` — the window screens B/C filter by (§8.3). `all` means "no window";
 * omitting it means the server default. Any other value is 422 at the edge.
 */
const DaysQuery = z.object({
  days: z.union([z.literal('all'), z.coerce.number().int().positive()]).optional(),
});

/** R11 — `?days` plus an optional cap on how many batch rows come back. */
const BatchesQuery = DaysQuery.extend({
  limit: z.coerce.number().int().positive().optional(),
});

/** R12 — narrow the run rows to one batch and/or cap them. */
const RunsQuery = z.object({
  batch_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

/**
 * R7 — `?force=true`. Deliberately fail-closed: only the exact string `true`
 * forces, so a stray `?force`, `?force=1` or `?force=maybe` still gets the
 * guarded 409 rather than silently erasing run history.
 */
const ForceQuery = z.object({ force: z.string().optional() });

/** R16 — two batch ids of the SAME agent; the 422s are the service's call. */
const CompareQuery = z.object({
  base: z.string().uuid(),
  head: z.string().uuid(),
});

/** `?days=` → the service's `number | null` window. */
function windowDays(days: 'all' | number | undefined): number | null {
  if (days === undefined) return DEFAULT_WINDOW_DAYS;
  return days === 'all' ? null : days;
}

/**
 * C5 — the SECOND parse gate on the R4/R6 bodies.
 *
 * The frozen `EvalCaseInput` types `owner_id` as a bare `z.string()` and
 * `expected_output` as `z.unknown()`, so passing its schema is not proof that
 * the body is safe to persist. This is defence in depth, not the only gate:
 * `EvalService` re-validates both one ring in, where the write actually
 * happens. Both layers exist because a route can be added without a service,
 * and a service can be called without a route.
 */
function assertCaseInput(body: Partial<EvalCaseInput>): void {
  if (body.owner_id !== undefined && !z.string().uuid().safeParse(body.owner_id).success) {
    throw new ValidationError('owner_id must be a uuid');
  }
  if (body.expected_output !== undefined) {
    const parsed = EvalExpectedOutput.safeParse(body.expected_output);
    if (!parsed.success) {
      throw new ValidationError(
        'expected_output is not a valid EvalExpectedOutput',
        parsed.error.flatten(),
      );
    }
  }
}

export default async function evalRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;
  // Resolved from the composition root, never `new` — the container is the only
  // place in the codebase allowed to name `EvalRepository` / `EvalRunner` /
  // `EvalDashboardService` / `EvalService` (onion §2).
  const { cases, runner, dashboard } = container.evalService;

  // -------------------------------------------------------------------------
  // R1 — one-click case creation from a judged finding (§7)
  // -------------------------------------------------------------------------

  /**
   * 201 on create, **200** on the idempotent re-click (AC-9): the unique index
   * on `source_finding_id` means a second click can only ever return the case
   * the first one made, and answering 201 twice would tell the client it
   * created two rows.
   *
   * The body is optional (a bare click sends none), so it is parsed here rather
   * than declared as a route schema — a declared object schema would 422 the
   * body-less request that is the common case.
   */
  app.post('/findings/:id/eval-case', { schema: { params: IdParams } }, async (req, reply) => {
    const { workspaceId } = await getContext(container, req);
    const parsed = EvalCaseFromFindingInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid eval case input', parsed.error.flatten());
    }
    const { created, record } = await cases.createFromFinding(
      workspaceId,
      req.params.id,
      parsed.data,
    );
    reply.status(created ? 201 : 200);
    return record;
  });

  /**
   * R1b — the composed-but-UNSAVED case a finding would produce (C24).
   *
   * The PR page opens the case editor on this, so "Turn into eval case" writes
   * nothing until the user saves. Same guards and same composition as R1, so
   * what the modal shows is what a bare Save persists.
   */
  app.get('/findings/:id/eval-case-draft', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(container, req);
    return cases.draftFromFinding(workspaceId, req.params.id);
  });

  // -------------------------------------------------------------------------
  // R2/R3/R5 — reads
  // -------------------------------------------------------------------------

  /** Which findings of this PR already have a case — the FindingCard join (C22). */
  app.get('/pulls/:id/eval-cases', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(container, req);
    return cases.linksForPull(workspaceId, req.params.id);
  });

  app.get('/agents/:id/eval-cases', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(container, req);
    return cases.listForAgent(workspaceId, req.params.id);
  });

  app.get('/eval-cases/:id', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(container, req);
    return cases.getCase(workspaceId, req.params.id);
  });

  // -------------------------------------------------------------------------
  // R4/R6/R7 — writes
  // -------------------------------------------------------------------------

  app.post('/eval-cases', { schema: { body: EvalCaseInput } }, async (req, reply) => {
    const { workspaceId } = await getContext(container, req);
    assertCaseInput(req.body);
    const record = await cases.createCase(workspaceId, req.body);
    reply.status(201);
    return record;
  });

  app.put(
    '/eval-cases/:id',
    { schema: { params: IdParams, body: EvalCaseInput.partial() } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      assertCaseInput(req.body);
      return cases.updateCase(workspaceId, req.params.id, req.body);
    },
  );

  /** 409 `case_has_runs` (with `details.run_count`) unless `?force=true` (AC-12). */
  app.delete(
    '/eval-cases/:id',
    { schema: { params: IdParams, querystring: ForceQuery } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return cases.deleteCase(workspaceId, req.params.id, { force: req.query.force === 'true' });
    },
  );

  // -------------------------------------------------------------------------
  // R8/R9/R17 — the three endpoints that spend money
  // -------------------------------------------------------------------------

  /**
   * R8 — run ONE case synchronously and answer with its result. The case
   * resolves its own agent, so a caller can never point a case at a foreign one.
   *
   * NO per-route rate limiter, deliberately (§6): the spend bounds for R8/R9/R17
   * are the in-flight lock (one batch per agent) and `MAX_CASES_PER_BATCH`, not
   * a request counter. Adding one here would diverge from the spec.
   */
  app.post('/eval-cases/:id/run', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(container, req);
    return cases.runCase(workspaceId, req.params.id);
  });

  /**
   * R8b — run an UNSAVED case against an agent and persist nothing.
   *
   * The case editor's "Run case" before Save. It writes no `eval_runs` row, so
   * a draft run never moves a metric and never appears in a batch.
   */
  app.post(
    '/agents/:id/eval-cases/run-draft',
    { schema: { params: IdParams, body: EvalDraftRunInput } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return cases.runDraftCase(workspaceId, req.params.id, req.body);
    },
  );

  /**
   * R9 — start a batch. **202**: the pending `eval_runs` rows exist before this
   * returns (§5.3), so `cases_total` is already knowable, but the run itself is
   * fire-and-forget and the client polls R10 for progress.
   *
   * Optional body (`{ case_ids }`); omitted ⇒ every case of the agent.
   */
  app.post(
    '/agents/:id/eval-runs',
    { schema: { params: IdParams } },
    async (req, reply) => {
      const { workspaceId } = await getContext(container, req);
      const parsed = EvalBatchRunInput.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ValidationError('Invalid batch run input', parsed.error.flatten());
      }
      const started = await runner.startBatch(workspaceId, req.params.id, parsed.data.case_ids);
      reply.status(202);
      return started;
    },
  );

  /** R17 — one batch per eligible agent. **202**; `skipped` explains the rest (AC-34). */
  app.post('/evals/run-all', async (req, reply) => {
    const { workspaceId } = await getContext(container, req);
    const result = await dashboard.runAll(workspaceId);
    reply.status(202);
    return result;
  });

  // -------------------------------------------------------------------------
  // R10-R13, R15, R16 — read-side aggregation
  // -------------------------------------------------------------------------

  app.get('/evals/batches/:batchId', { schema: { params: BatchParams } }, async (req) => {
    const { workspaceId } = await getContext(container, req);
    return dashboard.batchRecord(workspaceId, req.params.batchId);
  });

  /**
   * R11 — the drill-down's RECENT RUNS table. Served from the same windowed
   * projection as R13 so the table can never disagree with the metric cards
   * above it (§8.3); `?limit` only trims the already-windowed, newest-first list.
   */
  app.get(
    '/agents/:id/eval-batches',
    { schema: { params: IdParams, querystring: BatchesQuery } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      const view = await dashboard.agentDashboard(
        workspaceId,
        req.params.id,
        windowDays(req.query.days),
      );
      return req.query.limit === undefined ? view.batches : view.batches.slice(0, req.query.limit);
    },
  );

  app.get(
    '/agents/:id/eval-runs',
    { schema: { params: IdParams, querystring: RunsQuery } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return dashboard.runsForAgent(workspaceId, req.params.id, {
        batchId: req.query.batch_id ?? null,
        ...(req.query.limit !== undefined ? { limit: req.query.limit } : {}),
      });
    },
  );

  app.get(
    '/agents/:id/eval-dashboard',
    { schema: { params: IdParams, querystring: DaysQuery } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return dashboard.agentDashboard(workspaceId, req.params.id, windowDays(req.query.days));
    },
  );

  app.get('/evals/dashboard', async (req) => {
    const { workspaceId } = await getContext(container, req);
    return dashboard.overview(workspaceId);
  });

  app.get('/evals/compare', { schema: { querystring: CompareQuery } }, async (req) => {
    const { workspaceId } = await getContext(container, req);
    return dashboard.compare(workspaceId, req.query.base, req.query.head);
  });
}
