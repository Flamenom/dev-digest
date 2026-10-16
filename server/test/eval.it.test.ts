import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient, MockLLMProvider } from '../src/adapters/mocks.js';
import { caseFingerprint } from '../src/modules/eval/scoring.js';
import { BATCH_STALE_MINUTES } from '../src/modules/eval/constants.js';
import type { EvalActualOutput, EvalExpectedOutput } from '@devdigest/shared';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  console.warn('[eval] Docker not available — skipping integration tests.');
}

/**
 * L06 Eval Pipeline against a real Postgres — the cases the hermetic
 * `verify:l06` gate deliberately cannot cover (plan T18):
 *
 *  · migration `0018` round-trip: the four added columns read back, and the
 *    PLAIN unique index on `source_finding_id` tolerating many NULLs;
 *  · the two added indexes are actually USED by the planner, not merely present;
 *  · batch grouping over real rows, with a pre-0018 row (`batch_id` null) still
 *    readable and never joining a batch (AC-35);
 *  · tenancy: another workspace's case / batch / agent answer 404, never 403
 *    (AC-11, plan C14 — `eval_runs.owner_id` is NOT a tenancy column);
 *  · the guarded delete: 409 `case_has_runs` leaves every row, `?force=true`
 *    cascades (AC-12);
 *  · a back-dated pending row reporting as errored so the batch leaves
 *    `running` with no reaper job (AC-50);
 *  · R1's idempotency end-to-end over real `pr_files.patch` data (AC-9);
 *  · compare with a case edited between two batches (AC-33);
 *  · promote v1 while at v3 (AC-31) and the identical re-promote (AC-32).
 *
 * Everything that spends a model call is either stubbed or side-stepped: the
 * batch rows are written directly, because what is under test here is the
 * SCHEMA and the read-side aggregation, not the runner (that is T16's job).
 */
d('eval pipeline (integration)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let securityAgentId: string;
  /** A second tenant. Invisible to the app: `LocalNoAuthProvider` resolves the workspace named `default`. */
  let otherWorkspaceId: string;

  const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

  function makeApp() {
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        git: new MockGitClient(),
        github: new MockGitHubClient(),
        // Every seeded agent is `provider: 'openrouter'` (plan C2 widened
        // `MockLLMProvider.id` so this key is expressible).
        llm: { openrouter: new MockLLMProvider('openrouter') },
      },
    });
  }

  // ---------------------------------------------------------------- fixtures

  const DIFF = [
    'diff --git a/src/pay.ts b/src/pay.ts',
    '--- a/src/pay.ts',
    '+++ b/src/pay.ts',
    '@@ -10,3 +10,4 @@',
    '   port: 3000,',
    '+  stripeKey: "sk_live_xxx",',
    '   redisUrl: x,',
  ].join('\n');

  const EXPECTED: EvalExpectedOutput = {
    kind: 'must_find',
    expectations: [{ file: 'src/pay.ts', start_line: 11, end_line: 11, title: 'Hardcoded key' }],
  };

  /** A C7 blob with the minimum every reader needs; `case_fingerprint` is the part compare reads. */
  function actualOutput(
    fingerprint: string,
    over: Partial<EvalActualOutput> = {},
  ): EvalActualOutput {
    return {
      findings: [],
      pre_gate_count: 1,
      grounding_kept: 1,
      grounding_total: 1,
      grounding_dropped: [],
      matched_expectations: 1,
      noise_findings: 0,
      case_fingerprint: fingerprint,
      expectation_kind: 'must_find',
      ...over,
    };
  }

  let agentSeq = 0;
  async function mkAgent(ws: string, name?: string) {
    const [row] = await pg.handle.db
      .insert(t.agents)
      .values({
        workspaceId: ws,
        name: name ?? `Eval Agent ${agentSeq++}`,
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash',
        systemPrompt: 'review the diff',
      })
      .returning();
    return row!;
  }

  let caseSeq = 0;
  async function mkCase(
    ws: string,
    ownerId: string,
    over: Partial<typeof t.evalCases.$inferInsert> = {},
  ) {
    const [row] = await pg.handle.db
      .insert(t.evalCases)
      .values({
        workspaceId: ws,
        ownerKind: 'agent',
        ownerId,
        name: `case-${caseSeq++}`,
        inputDiff: DIFF,
        inputMeta: { title: 'Add rate limiting', number: 482 },
        expectedOutput: EXPECTED,
        ...over,
      })
      .returning();
    return row!;
  }

  async function mkRun(values: typeof t.evalRuns.$inferInsert) {
    const [row] = await pg.handle.db.insert(t.evalRuns).values(values).returning();
    return row!;
  }

  /** The fingerprint the runner would compute for the case AS IT IS STORED RIGHT NOW. */
  async function fingerprintOf(caseId: string): Promise<string> {
    const [row] = await pg.handle.db
      .select()
      .from(t.evalCases)
      .where(eq(t.evalCases.id, caseId));
    return caseFingerprint(row!.inputDiff ?? '', row!.inputMeta, row!.expectedOutput);
  }

  beforeAll(async () => {
    pg = await startPg();
    // TWICE on purpose: `seed()` is insert-only and guarded on
    // (workspace_id, owner_id, name) because `eval_cases` has NO unique
    // constraint on that triple — a second run must not double the set, and
    // must not trip `eval_cases_source_finding_uq` with its ten NULL
    // `source_finding_id` values.
    const first = await seed(pg.handle.db);
    await seed(pg.handle.db);
    workspaceId = first.workspaceId;

    const [security] = await pg.handle.db
      .select({ id: t.agents.id })
      .from(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.name, 'Security Reviewer')));
    securityAgentId = security!.id;

    const [other] = await pg.handle.db
      .insert(t.workspaces)
      .values({ name: 'other-tenant' })
      .returning();
    otherWorkspaceId = other!.id;
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  // =========================================================================
  // Migration 0018
  // =========================================================================

  it('0018 round-trips: the four columns read back and the unique index tolerates many NULL source_finding_id values', async () => {
    const { db, sql: raw } = pg.handle;

    // Two `seed()` runs, still exactly the ten seeded cases — and all ten carry
    // a NULL `source_finding_id`, which the PLAIN unique index must allow.
    const seeded = await db
      .select({ id: t.evalCases.id, sourceFindingId: t.evalCases.sourceFindingId })
      .from(t.evalCases)
      .where(
        and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.ownerId, securityAgentId)),
      );
    expect(seeded).toHaveLength(10);
    expect(seeded.every((c) => c.sourceFindingId === null)).toBe(true);

    // …and more NULLs on top of those ten are still legal.
    const agent = await mkAgent(workspaceId);
    await mkCase(workspaceId, agent.id, { sourceFindingId: null });
    await mkCase(workspaceId, agent.id, { sourceFindingId: null });
    const nulls = await db
      .select({ id: t.evalCases.id })
      .from(t.evalCases)
      .where(sql`${t.evalCases.sourceFindingId} is null`);
    expect(nulls.length).toBeGreaterThanOrEqual(12);

    // A DUPLICATE non-null value is what the index actually forbids, and the
    // repository's shape-matcher keys off exactly this constraint name.
    const findingId = randomUUID();
    await mkCase(workspaceId, agent.id, { sourceFindingId: findingId });
    const dup = await mkCase(workspaceId, agent.id, { sourceFindingId: findingId }).catch(
      (err: unknown) => err as { code?: string; constraint_name?: string },
    );
    expect(dup).toMatchObject({ code: '23505', constraint_name: 'eval_cases_source_finding_uq' });

    // NULLS NOT DISTINCT would allow only ONE unprovenanced case — the schema
    // comment says "do NOT add it", so pin the physical definition.
    const [indexDef] = await raw<{ indexdef: string }[]>`
      select indexdef from pg_indexes where indexname = 'eval_cases_source_finding_uq'`;
    expect(indexDef!.indexdef).toContain('CREATE UNIQUE INDEX');
    expect(indexDef!.indexdef).not.toContain('NULLS NOT DISTINCT');

    // The three columns 0018 adds to `eval_runs`, written and read back.
    const evalCase = await mkCase(workspaceId, agent.id);
    const batchId = randomUUID();
    const run = await mkRun({
      caseId: evalCase.id,
      batchId,
      agentVersion: 7,
      ownerId: agent.id,
      actualOutput: actualOutput('fp-roundtrip'),
      pass: true,
    });
    const [readBack] = await db
      .select({
        batchId: t.evalRuns.batchId,
        agentVersion: t.evalRuns.agentVersion,
        ownerId: t.evalRuns.ownerId,
      })
      .from(t.evalRuns)
      .where(eq(t.evalRuns.id, run.id));
    expect(readBack).toEqual({ batchId, agentVersion: 7, ownerId: agent.id });
  });

  it('0018s indexes are actually used by the planner, not merely present', async () => {
    const { db, sql: raw } = pg.handle;

    // A THIRD workspace so these bulk rows cannot perturb any other test's
    // dashboard read. The owners are bare uuids with no `agents` row, so the
    // grouped batch query's INNER JOIN on `agents` drops them regardless.
    const [perfWs] = await db.insert(t.workspaces).values({ name: 'perf-tenant' }).returning();
    const perfCase = await mkCase(perfWs!.id, randomUUID());

    const owners = Array.from({ length: 60 }, () => randomUUID());
    const batches = owners.map(() => randomUUID());
    const base = Date.now() - 86_400_000;
    for (let o = 0; o < owners.length; o += 1) {
      const rows = Array.from({ length: 50 }, (_, i) => ({
        caseId: perfCase.id,
        batchId: batches[o]!,
        ownerId: owners[o]!,
        agentVersion: 1,
        ranAt: new Date(base + o * 60_000 + i * 1_000),
        actualOutput: actualOutput(`fp-${o}-${i}`),
        pass: true,
      }));
      await db.insert(t.evalRuns).values(rows);
    }
    await raw.unsafe('analyze eval_runs');

    // `eval_runs_owner_ran_idx (owner_id, ran_at desc)` — the per-agent history
    // read (`listRunsForAgent`), leftmost-prefix on owner_id.
    //
    // Observed plan at this size: `Bitmap Index Scan on eval_runs_owner_ran_idx`
    // feeding a separate `Sort` node. The index earns its keep on the equality
    // prefix; the `ran_at desc` half is not (yet) exploited for ordering,
    // because a bitmap scan of ~50 matching rows plus a sort is cheaper than an
    // ordered index scan. Assert only the index NAME — pinning the node type
    // would break the moment the table grows past the crossover.
    const ownerPlan = (
      await raw.unsafe<{ 'QUERY PLAN': string }[]>(
        `explain select id from eval_runs where owner_id = '${owners[0]}'::uuid` +
          ` order by ran_at desc limit 20`,
      )
    )
      .map((r) => r['QUERY PLAN'])
      .join('\n');
    expect(ownerPlan).toContain('eval_runs_owner_ran_idx');

    // `eval_runs_batch_idx` — every row of one batch (`runsForBatch`).
    const batchPlan = (
      await raw.unsafe<{ 'QUERY PLAN': string }[]>(
        `explain select id from eval_runs where batch_id = '${batches[0]}'::uuid`,
      )
    )
      .map((r) => r['QUERY PLAN'])
      .join('\n');
    expect(batchPlan).toContain('eval_runs_batch_idx');
  });

  // =========================================================================
  // Batch grouping · pre-0018 rows (AC-35)
  // =========================================================================

  it('groups batches over real rows; a pre-0018 row (batch_id null) still reads and never joins a batch', async () => {
    const app = await makeApp();
    const agent = await mkAgent(workspaceId);
    const c1 = await mkCase(workspaceId, agent.id);
    const c2 = await mkCase(workspaceId, agent.id);

    const batchId = randomUUID();
    const batchRanAt = new Date(Date.now() - 5 * 60_000);
    for (const c of [c1, c2]) {
      await mkRun({
        caseId: c.id,
        batchId,
        ownerId: agent.id,
        agentVersion: 3,
        ranAt: batchRanAt,
        actualOutput: actualOutput(await fingerprintOf(c.id)),
        pass: true,
        durationMs: 1000,
        costUsd: 0.002,
      });
    }

    // The AC-35 row: written before 0018, so `batch_id` / `owner_id` /
    // `agent_version` are all NULL. It is the NEWEST run of c1.
    const legacy = await mkRun({
      caseId: c1.id,
      batchId: null,
      ownerId: null,
      agentVersion: null,
      ranAt: new Date(),
      actualOutput: actualOutput('fp-legacy'),
      pass: false,
      durationMs: 900,
    });

    const batches = (
      await app.inject({ method: 'GET', url: `/agents/${agent.id}/eval-batches` })
    ).json();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      batch_id: batchId,
      agent_id: agent.id,
      agent_version: 3,
      cases_total: 2,
      status: 'complete',
    });

    const record = await app.inject({ method: 'GET', url: `/evals/batches/${batchId}` });
    expect(record.statusCode).toBe(200);
    expect(record.json().cases_total).toBe(2);

    // R12 narrows by `eval_runs.owner_id`, so the legacy row is invisible there…
    const runs = (
      await app.inject({ method: 'GET', url: `/agents/${agent.id}/eval-runs` })
    ).json();
    expect(runs).toHaveLength(2);

    // …but `latestRunPerCase` keys off `eval_cases`, so the case still reports
    // it as its last run. Readable, just never part of a batch.
    const caseRecord = (
      await app.inject({ method: 'GET', url: `/eval-cases/${c1.id}` })
    ).json();
    expect(caseRecord.last_run).toMatchObject({ run_id: legacy.id, pass: false });

    await app.close();
  });

  // =========================================================================
  // Tenancy (AC-11, plan C14)
  // =========================================================================

  it("another workspace's case, batch and agent answer 404 — never 403", async () => {
    const app = await makeApp();
    const foreignAgent = await mkAgent(otherWorkspaceId, 'Foreign Reviewer');
    const foreignCase = await mkCase(otherWorkspaceId, foreignAgent.id);
    const foreignBatch = randomUUID();
    const foreignRun = await mkRun({
      caseId: foreignCase.id,
      batchId: foreignBatch,
      ownerId: foreignAgent.id,
      agentVersion: 1,
      actualOutput: actualOutput('fp-foreign'),
      pass: true,
    });

    const attempts = [
      { method: 'GET' as const, url: `/eval-cases/${foreignCase.id}` },
      { method: 'PUT' as const, url: `/eval-cases/${foreignCase.id}`, payload: { name: 'hax' } },
      { method: 'DELETE' as const, url: `/eval-cases/${foreignCase.id}?force=true` },
      { method: 'GET' as const, url: `/evals/batches/${foreignBatch}` },
      { method: 'GET' as const, url: `/agents/${foreignAgent.id}/eval-cases` },
      { method: 'GET' as const, url: `/agents/${foreignAgent.id}/eval-dashboard` },
      { method: 'GET' as const, url: `/agents/${foreignAgent.id}/eval-runs` },
      { method: 'POST' as const, url: `/agents/${foreignAgent.id}/eval-runs`, payload: {} },
    ];
    for (const attempt of attempts) {
      const res = await app.inject(attempt);
      expect(
        { url: attempt.url, status: res.statusCode },
        `${attempt.method} ${attempt.url}`,
      ).toEqual({ url: attempt.url, status: 404 });
      expect(res.json().error.code).toBe('not_found');
    }

    // `/evals/compare` over a foreign batch is the same 404, not a 422.
    const compare = await app.inject({
      method: 'GET',
      url: `/evals/compare?base=${foreignBatch}&head=${randomUUID()}`,
    });
    expect(compare.statusCode).toBe(404);

    // Nothing of the other tenant was read, written or erased.
    const stillThere = await pg.handle.db
      .select({ id: t.evalCases.id, name: t.evalCases.name })
      .from(t.evalCases)
      .where(eq(t.evalCases.id, foreignCase.id));
    expect(stillThere).toEqual([{ id: foreignCase.id, name: foreignCase.name }]);
    const foreignRuns = await pg.handle.db
      .select({ id: t.evalRuns.id })
      .from(t.evalRuns)
      .where(eq(t.evalRuns.id, foreignRun.id));
    expect(foreignRuns).toHaveLength(1);

    // And the foreign batch never leaks into this workspace's overview.
    const overview = (await app.inject({ method: 'GET', url: '/evals/dashboard' })).json();
    const leaked = overview.recent_batches.some(
      (b: { batch_id: string }) => b.batch_id === foreignBatch,
    );
    expect(leaked).toBe(false);

    await app.close();
  });

  // =========================================================================
  // Guarded delete (AC-12)
  // =========================================================================

  it('delete is guarded: 409 case_has_runs leaves every row, ?force=true cascades the runs', async () => {
    const app = await makeApp();
    const agent = await mkAgent(workspaceId);
    const evalCase = await mkCase(workspaceId, agent.id);
    const batchId = randomUUID();
    for (let i = 0; i < 2; i += 1) {
      await mkRun({
        caseId: evalCase.id,
        batchId,
        ownerId: agent.id,
        agentVersion: 1,
        actualOutput: actualOutput(`fp-del-${i}`),
        pass: true,
      });
    }

    const guarded = await app.inject({ method: 'DELETE', url: `/eval-cases/${evalCase.id}` });
    expect(guarded.statusCode).toBe(409);
    expect(guarded.json().error).toMatchObject({
      code: 'case_has_runs',
      details: { case_id: evalCase.id, run_count: 2 },
    });

    // Fail-closed: only the exact string `true` forces.
    const notTrue = await app.inject({
      method: 'DELETE',
      url: `/eval-cases/${evalCase.id}?force=1`,
    });
    expect(notTrue.statusCode).toBe(409);

    // The refusal wrote nothing.
    const survivors = await pg.handle.db
      .select({ id: t.evalRuns.id })
      .from(t.evalRuns)
      .where(eq(t.evalRuns.caseId, evalCase.id));
    expect(survivors).toHaveLength(2);

    const forced = await app.inject({
      method: 'DELETE',
      url: `/eval-cases/${evalCase.id}?force=true`,
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.json()).toEqual({ deleted: true });

    // `eval_runs.case_id` is ON DELETE CASCADE — the history really is gone.
    const afterCase = await pg.handle.db
      .select({ id: t.evalCases.id })
      .from(t.evalCases)
      .where(eq(t.evalCases.id, evalCase.id));
    const afterRuns = await pg.handle.db
      .select({ id: t.evalRuns.id })
      .from(t.evalRuns)
      .where(eq(t.evalRuns.caseId, evalCase.id));
    expect(afterCase).toHaveLength(0);
    expect(afterRuns).toHaveLength(0);

    // …and the batch it was part of is now empty, hence 404 (AC-12's "shrinks
    // every past batch", taken to its limit).
    const gone = await app.inject({ method: 'GET', url: `/evals/batches/${batchId}` });
    expect(gone.statusCode).toBe(404);

    await app.close();
  });

  // =========================================================================
  // Derived status + the stale window (AC-50)
  // =========================================================================

  it('a back-dated pending row reports as errored and the batch leaves running', async () => {
    const app = await makeApp();
    const agent = await mkAgent(workspaceId);
    const c1 = await mkCase(workspaceId, agent.id);
    const c2 = await mkCase(workspaceId, agent.id);

    const staleAt = new Date(Date.now() - (BATCH_STALE_MINUTES + 1) * 60_000);

    // A batch stranded by an API restart: one row finished, one still pending
    // and older than the stale window.
    const stranded = randomUUID();
    await mkRun({
      caseId: c1.id,
      batchId: stranded,
      ownerId: agent.id,
      agentVersion: 1,
      ranAt: staleAt,
      actualOutput: actualOutput(await fingerprintOf(c1.id)),
      pass: true,
    });
    await mkRun({
      caseId: c2.id,
      batchId: stranded,
      ownerId: agent.id,
      agentVersion: 1,
      ranAt: staleAt,
      actualOutput: null,
    });

    const strandedRecord = (
      await app.inject({ method: 'GET', url: `/evals/batches/${stranded}` })
    ).json();
    expect(strandedRecord).toMatchObject({
      status: 'complete',
      cases_total: 2,
      cases_errored: 1,
    });

    // Every row stale ⇒ `failed`, not a permanently `running` ghost.
    const allStale = randomUUID();
    await mkRun({
      caseId: c1.id,
      batchId: allStale,
      ownerId: agent.id,
      agentVersion: 1,
      ranAt: staleAt,
      actualOutput: null,
    });
    const failed = (
      await app.inject({ method: 'GET', url: `/evals/batches/${allStale}` })
    ).json();
    expect(failed).toMatchObject({ status: 'failed', cases_total: 1, cases_errored: 1 });

    // A pending row INSIDE the window is still honestly `running`.
    const live = randomUUID();
    await mkRun({
      caseId: c2.id,
      batchId: live,
      ownerId: agent.id,
      agentVersion: 1,
      ranAt: new Date(),
      actualOutput: null,
    });
    const running = (await app.inject({ method: 'GET', url: `/evals/batches/${live}` })).json();
    expect(running.status).toBe('running');

    await app.close();
  });

  // =========================================================================
  // R1 over real pr_files.patch data (AC-9)
  // =========================================================================

  /** A repo + PR + one `pr_files` row that actually carries a patch (the seed's rows do not). */
  async function setupPrWithPatch(ws: string, slug: string) {
    const { db } = pg.handle;
    const [repo] = await db
      .insert(t.repos)
      .values({ workspaceId: ws, owner: 'acme', name: slug, fullName: `acme/${slug}` })
      .returning();
    const [pr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId: ws,
        repoId: repo!.id,
        number: 482,
        title: 'Add rate limiting',
        author: 'marisa.koch',
        branch: 'feat/rl',
        base: 'main',
        headSha: 'a1b2c3d4',
        body: 'Add rate limiting. Closes #471.',
      })
      .returning();
    await db.insert(t.prFiles).values({
      prId: pr!.id,
      path: 'src/pay.ts',
      additions: 1,
      patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,',
    });
    return pr!;
  }

  async function mkFinding(
    reviewId: string,
    over: Partial<typeof t.findings.$inferInsert> = {},
  ) {
    const [row] = await pg.handle.db
      .insert(t.findings)
      .values({
        reviewId,
        file: 'src/pay.ts',
        startLine: 11,
        endLine: 11,
        severity: 'CRITICAL',
        category: 'security',
        title: 'Hardcoded Stripe secret key',
        rationale: 'A live Stripe key is committed in source.',
        confidence: 0.95,
        acceptedAt: new Date(),
        ...over,
      })
      .returning();
    return row!;
  }

  it('R1 is idempotent end-to-end over real pr_files.patch data', async () => {
    const app = await makeApp();
    const agent = await mkAgent(workspaceId);
    const pr = await setupPrWithPatch(workspaceId, 'eval-r1');
    const [review] = await pg.handle.db
      .insert(t.reviews)
      .values({ workspaceId, prId: pr.id, agentId: agent.id, kind: 'review', score: 42 })
      .returning();
    const finding = await mkFinding(review!.id);

    const first = await app.inject({
      method: 'POST',
      url: `/findings/${finding.id}/eval-case`,
    });
    expect(first.statusCode).toBe(201);
    const created = first.json();
    expect(created).toMatchObject({
      owner_kind: 'agent',
      owner_id: agent.id,
      source_finding_id: finding.id,
    });
    // The WHOLE file patch, rebuilt as a single-file unified diff — a trimmed
    // patch would invalidate the hunk headers the grounding gate indexes.
    expect(created.input_diff).toContain('diff --git a/src/pay.ts b/src/pay.ts');
    expect(created.input_diff).toContain('+++ b/src/pay.ts');
    expect(created.input_diff).toContain('+  stripeKey: "sk_live_xxx",');
    expect(created.expected_output).toMatchObject({
      kind: 'must_find',
      expectations: [{ file: 'src/pay.ts', start_line: 11, end_line: 11 }],
    });
    // The expectation lands inside a real hunk, so nothing is warned about.
    expect(created.diff_warnings).toEqual([]);

    // The re-click: 200, not 201, and the SAME row.
    const second = await app.inject({
      method: 'POST',
      url: `/findings/${finding.id}/eval-case`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(created.id);

    const rows = await pg.handle.db
      .select({ id: t.evalCases.id })
      .from(t.evalCases)
      .where(eq(t.evalCases.sourceFindingId, finding.id));
    expect(rows).toHaveLength(1);

    // R2 — the PR page's "already has a case" join, over the soft (FK-less) pointer.
    const links = (
      await app.inject({ method: 'GET', url: `/pulls/${pr.id}/eval-cases` })
    ).json();
    expect(links).toEqual([
      { finding_id: finding.id, case_id: created.id, case_name: created.name },
    ]);

    await app.close();
  });

  it('R1s DB-shaped refusals: no agent on the review, no stored patch, unjudged, foreign tenant', async () => {
    const app = await makeApp();
    const agent = await mkAgent(workspaceId);
    const pr = await setupPrWithPatch(workspaceId, 'eval-r1-refusals');

    // `reviews.agent_id` is nullable with NO foreign key — this is a real row
    // shape (a summary written without an agent), not a theoretical one.
    const [agentless] = await pg.handle.db
      .insert(t.reviews)
      .values({ workspaceId, prId: pr.id, agentId: null, kind: 'summary' })
      .returning();
    const orphan = await mkFinding(agentless!.id);
    const noAgent = await app.inject({
      method: 'POST',
      url: `/findings/${orphan.id}/eval-case`,
    });
    expect(noAgent.statusCode).toBe(409);
    expect(noAgent.json().error.code).toBe('finding_has_no_agent');

    const [review] = await pg.handle.db
      .insert(t.reviews)
      .values({ workspaceId, prId: pr.id, agentId: agent.id, kind: 'review' })
      .returning();

    // A file with no `pr_files` row at all — the default outcome against seeded
    // data, whose `pr_files` rows carry no patch.
    const noPatch = await mkFinding(review!.id, { file: 'src/untracked.ts' });
    const noPatchRes = await app.inject({
      method: 'POST',
      url: `/findings/${noPatch.id}/eval-case`,
    });
    expect(noPatchRes.statusCode).toBe(409);
    expect(noPatchRes.json().error.code).toBe('no_patch_for_file');

    const unjudged = await mkFinding(review!.id, { acceptedAt: null, dismissedAt: null });
    const unjudgedRes = await app.inject({
      method: 'POST',
      url: `/findings/${unjudged.id}/eval-case`,
    });
    expect(unjudgedRes.statusCode).toBe(409);
    expect(unjudgedRes.json().error.code).toBe('finding_not_judged');

    // `findingContext` is NOT workspace-scoped, so the service's own tenant
    // assertion is the only barrier here — and it must answer 404, never 403.
    const foreignPr = await setupPrWithPatch(otherWorkspaceId, 'eval-r1-foreign');
    const [foreignReview] = await pg.handle.db
      .insert(t.reviews)
      .values({
        workspaceId: otherWorkspaceId,
        prId: foreignPr.id,
        agentId: (await mkAgent(otherWorkspaceId)).id,
        kind: 'review',
      })
      .returning();
    const foreignFinding = await mkFinding(foreignReview!.id);
    const foreignRes = await app.inject({
      method: 'POST',
      url: `/findings/${foreignFinding.id}/eval-case`,
    });
    expect(foreignRes.statusCode).toBe(404);
    expect(foreignRes.json().error.code).toBe('not_found');

    await app.close();
  });

  // =========================================================================
  // Compare (AC-33)
  // =========================================================================

  it('compare: a case edited between two batches is not comparable and is named', async () => {
    const app = await makeApp();
    const agent = await mkAgent(workspaceId);
    const edited = await mkCase(workspaceId, agent.id);
    const stable = await mkCase(workspaceId, agent.id);

    async function writeBatch(ranAt: Date): Promise<string> {
      const batchId = randomUUID();
      for (const c of [edited, stable]) {
        await mkRun({
          caseId: c.id,
          batchId,
          ownerId: agent.id,
          agentVersion: 1,
          ranAt,
          // The fingerprint is read out of the C7 blob, exactly as the runner
          // writes it: whatever the case looked like when the batch ran.
          actualOutput: actualOutput(await fingerprintOf(c.id)),
          pass: true,
          costUsd: 0.001,
        });
      }
      return batchId;
    }

    const baseBatch = await writeBatch(new Date(Date.now() - 20_000));

    // The edit: a new input diff changes the case fingerprint (§4.7).
    const put = await app.inject({
      method: 'PUT',
      url: `/eval-cases/${edited.id}`,
      payload: { input_diff: `${DIFF}\n+  extra: true,` },
    });
    expect(put.statusCode).toBe(200);

    const headBatch = await writeBatch(new Date(Date.now() - 10_000));

    const res = await app.inject({
      method: 'GET',
      url: `/evals/compare?base=${baseBatch}&head=${headBatch}`,
    });
    expect(res.statusCode).toBe(200);
    const compare = res.json();
    expect(compare.base.batch_id).toBe(baseBatch);
    expect(compare.head.batch_id).toBe(headBatch);
    expect(compare.comparable).toBe(false);
    expect(compare.changed_case_ids).toEqual([edited.id]);
    expect(compare.promote_target_version).toBe(1);

    // Control: two batches run over the SAME case set are comparable.
    const headAgain = await writeBatch(new Date());
    const ok = (
      await app.inject({ method: 'GET', url: `/evals/compare?base=${headBatch}&head=${headAgain}` })
    ).json();
    expect(ok.comparable).toBe(true);
    expect(ok.changed_case_ids).toEqual([]);

    await app.close();
  });

  // =========================================================================
  // Promote (AC-31, AC-32)
  // =========================================================================

  it('promote v1 while at v3 creates v4 with v1s config; promoting again changes nothing', async () => {
    const app = await makeApp();

    const created = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'Promotable',
        provider: 'openai',
        model: 'gpt-4o-mini',
        system_prompt: 'v1 prompt',
      },
    });
    expect(created.statusCode).toBe(201);
    const agentId = created.json().id as string;

    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/agents/${agentId}`,
          payload: { model: 'gpt-4o' },
        })
      ).json().version,
    ).toBe(2);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/agents/${agentId}`,
          payload: { system_prompt: 'v3 prompt' },
        })
      ).json().version,
    ).toBe(3);

    const promoted = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/versions/1/promote`,
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({
      promoted_from_version: 1,
      new_version: 4,
      changed: true,
      agent: { version: 4, model: 'gpt-4o-mini', system_prompt: 'v1 prompt' },
    });

    // Append-only: v1..v3 are untouched and v4 is the new head.
    const versions = (
      await app.inject({ method: 'GET', url: `/agents/${agentId}/versions` })
    ).json();
    expect(versions.map((v: { version: number }) => v.version)).toEqual([4, 3, 2, 1]);
    const v1 = versions.find((v: { version: number }) => v.version === 1);
    const v4 = versions.find((v: { version: number }) => v.version === 4);
    expect(v4.config).toEqual(v1.config);

    // AC-32 — the live config now IS v1's, so a second promote creates nothing.
    const again = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/versions/1/promote`,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({
      promoted_from_version: 1,
      new_version: 4,
      changed: false,
    });
    const afterVersions = (
      await app.inject({ method: 'GET', url: `/agents/${agentId}/versions` })
    ).json();
    expect(afterVersions).toHaveLength(4);

    await app.close();
  });

  it('promote does NOT restore the snapshots skills — the new snapshot records the CURRENT links', async () => {
    const app = await makeApp();
    const created = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'Skill Promotable',
        provider: 'openai',
        model: 'gpt-4o-mini',
        system_prompt: 'v1 prompt',
      },
    });
    const agentId = created.json().id as string;

    // v1 was snapshotted with no linked skills.
    const v1 = (
      await app.inject({ method: 'GET', url: `/agents/${agentId}/versions/1` })
    ).json();
    expect(v1.config.skills).toEqual([]);

    const [skill] = await pg.handle.db
      .select({ id: t.skills.id })
      .from(t.skills)
      .where(eq(t.skills.workspaceId, workspaceId))
      .limit(1);
    expect(skill).toBeDefined();

    const linked = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { skill_ids: [skill!.id] },
    });
    expect(linked.statusCode).toBeLessThan(300);
    // Linking a skill is not a config change: no version bump, no snapshot.
    expect(
      (await app.inject({ method: 'GET', url: `/agents/${agentId}/versions` })).json(),
    ).toHaveLength(1);

    // Force a config change so promote has something to revert.
    await app.inject({
      method: 'PUT',
      url: `/agents/${agentId}`,
      payload: { model: 'gpt-4o' },
    });

    const promoted = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/versions/1/promote`,
    });
    expect(promoted.json()).toMatchObject({ new_version: 3, changed: true });

    // T12's recorded caveat, pinned so it can never change silently: the update
    // path has no skills channel, so promoting v1 does NOT unlink the skill —
    // and the snapshot it writes records the CURRENT links, not v1's.
    const v3 = (
      await app.inject({ method: 'GET', url: `/agents/${agentId}/versions/3` })
    ).json();
    expect(v3.config.model).toBe('gpt-4o-mini');
    expect(v3.config.skills).toEqual([skill!.id]);
    expect(v3.config.skills).not.toEqual(v1.config.skills);

    await app.close();
  });
});
