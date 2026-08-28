import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type {
  CompletionRequest,
  CompletionResult,
  LLMProvider,
  ModelInfo,
  PrBriefDetail,
  StructuredRequest,
  StructuredResult,
} from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitHubClient, MockGitClient, MockLLMProvider } from '../src/adapters/mocks.js';

/**
 * PR Why + Risk Brief — server integration suite (spec
 * `specs/2026-08-27-pr-brief.md`, plan `docs/plans/pr-why-risk-brief.md` T9).
 *
 * Driven end to end through `app.inject()` against a real Postgres (migration
 * 0016 applied) with the LLM behind a fixture, because almost every criterion
 * here is about what is PERSISTED and what is BILLED, not about a pure function:
 * the cache fingerprint (AC-4), the "no second model call" guarantee (AC-3,
 * NFR-4), the grounding drop before persistence (AC-11, AC-12), the
 * nothing-is-written failure paths (AC-14, AC-35, AC-36) and the cross-workspace
 * denial (AC-37) are all statements about rows and about `MockLLMProvider.calls`.
 * The pure rules those paths sit on (fingerprint, grounding, spend sum, rollup)
 * are unit-tested hermetically in `brief-helpers.test.ts` and
 * `review-rollup.test.ts` — this file deliberately does not repeat them.
 *
 * Two conventions worth knowing before editing:
 *  - `GET /pulls/:id/brief` is ALWAYS 200. A PR with no cached brief reports
 *    `generation.state = 'not_generated'`; the intent slice's 404-on-missing is
 *    deliberately NOT the pattern here. A 404 means "no such PR for you" (AC-37).
 *  - `MockLLMProvider` THROWS when a fixture fails the schema
 *    (`adapters/mocks.ts:91-94`), which is exactly how the AC-14 cap case is
 *    observed — expect a `failed` generation, not a silently trimmed one.
 *
 * Uses a UNIQUE repo `fullName` per PR: `seed()` already owns
 * `acme/payments-api` and would collide on `repos_ws_fullname_uq`
 * (server/INSIGHTS.md).
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  console.warn('[brief] Docker not available — skipping integration tests.');
}

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

// ---------------------------------------------------------------- fixtures

/**
 * `src/config.ts` gains one line: `@@ -10,3 +10,4 @@` ⇒ NEW-file lines 10–13 are
 * the changed range. Line 11 is groundable (AC-12 passes); line 500 is a real
 * file at an unchanged line (AC-12 drops it).
 */
const PATCH_CONFIG = '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,';
/** A new file: `@@ -0,0 +1,40 @@` ⇒ changed range 1–40. */
const PATCH_RATELIMIT = '@@ -0,0 +1,40 @@\n+export function rateLimit() {}';

/** First generation. Every reference is groundable, so nothing is dropped. */
const GEN_A = {
  what: 'Adds a per-IP token-bucket limiter in front of the public API endpoints.',
  why: 'Unbounded public traffic has been exhausting the upstream provider quota.',
  risks: [
    {
      kind: 'security',
      title: 'Hardcoded Stripe secret in configuration',
      explanation: 'A live Stripe key is introduced alongside the limiter settings.',
      severity: 'high',
      refs: [{ path: 'src/config.ts', start_line: 11, end_line: 11 }],
    },
  ],
  review_focus: [
    { path: 'src/config.ts', line: 11, reason: 'The secret is introduced on this line.' },
  ],
};

/**
 * Second generation for AC-6 — deliberately shares NO value with `GEN_A`
 * (different prose, different risk, different file), so "replaced wholesale"
 * is observable rather than assumed.
 */
const GEN_B = {
  what: 'Moves the limiter into dedicated middleware and drops the inline config hook.',
  why: 'The inline hook could not be reused by the internal API surface.',
  risks: [
    {
      kind: 'availability',
      title: 'Limiter defaults are now global',
      explanation: 'Every route inherits the middleware default instead of opting in.',
      severity: 'medium',
      refs: [{ path: 'src/middleware/ratelimit.ts', start_line: 5, end_line: 9 }],
    },
  ],
  review_focus: [
    {
      path: 'src/middleware/ratelimit.ts',
      line: 5,
      reason: 'The default bucket size is decided here.',
    },
  ],
};

/** An LLM fixture with a mix of groundable and ungroundable references (AC-11, AC-12). */
const GEN_UNGROUNDED = {
  what: 'Adds a limiter.',
  why: 'Traffic control.',
  risks: [
    {
      kind: 'security',
      title: 'Real risk on a real file',
      explanation: 'Cites a path inside the allowed-reference set.',
      severity: 'high',
      refs: [{ path: 'src/config.ts', start_line: 11 }],
    },
    {
      kind: 'security',
      title: 'Invented risk on an invented file',
      explanation: 'Cites a path the PR never touches and no finding mentions.',
      severity: 'high',
      refs: [{ path: 'src/totally/invented.ts', start_line: 1 }],
    },
  ],
  review_focus: [
    { path: 'src/config.ts', line: 11, reason: 'A changed line of a changed file.' },
    { path: 'src/config.ts', line: 500, reason: 'A real file, but an UNCHANGED line.' },
    { path: 'src/totally/invented.ts', line: 1, reason: 'An invented file.' },
  ],
};

/** Seven risks — one over the AC-14 cap of six, so `PrBriefGeneration` rejects it. */
const GEN_OVER_CAP = {
  what: 'Adds a limiter.',
  why: 'Traffic control.',
  risks: Array.from({ length: 7 }, (_, i) => ({
    kind: 'security',
    title: `Risk ${i}`,
    explanation: 'Over the cardinality cap.',
    severity: 'low',
    refs: [{ path: 'src/config.ts', start_line: 11 }],
  })),
  review_focus: [],
};

/**
 * A GitHub client whose issue fetch is down. Q4 re-fetches the linked issue per
 * GENERATION, so a failure here is a one-time note that only `regenerate` can
 * observe — the read has no way to recompute it (`missing_inputs` persistence).
 */
class IssueFetchFailingGitHubClient extends MockGitHubClient {
  override async getIssue(): Promise<never> {
    throw new Error('issue fetch failed');
  }
}

/** A provider that is simply down — the AC-36 path, distinct from a cap violation. */
class ExplodingLLMProvider implements LLMProvider {
  readonly id = 'openai' as const;
  public structuredCalls = 0;
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: 'gpt-4.1', provider: 'openai' }];
  }
  async complete(_req: CompletionRequest): Promise<CompletionResult> {
    throw new Error('provider unreachable');
  }
  async completeStructured<T>(_req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.structuredCalls += 1;
    throw new Error('provider unreachable');
  }
  async embed(_texts: string[]): Promise<number[][]> {
    throw new Error('provider unreachable');
  }
}

function briefLlm(fixture: unknown): MockLLMProvider {
  // `risk_brief`'s registry default provider is `openai` (contracts/platform.ts),
  // and the fixture key must be the `schemaName` the service sends.
  return new MockLLMProvider('openai', { structuredBySchema: { PrBriefGeneration: fixture } });
}

function structuredCalls(llm: MockLLMProvider) {
  return llm.calls.filter((c) => c.method === 'completeStructured');
}

// ------------------------------------------------------------------- suite

d('PR brief module (integration)', () => {
  let pg: PgFixture;
  let workspaceId: string;

  /** The primary PR — two agents, two runs, an intent row, two changed files. */
  let prId: string;
  let agentAId: string;
  let agentBId: string;
  let criticalFindingId: string;

  let repoSeq = 0;

  async function makePr(opts: {
    headSha?: string;
    body?: string | null;
    files?: { path: string; additions: number; deletions: number; patch: string | null }[];
    workspaceId?: string;
  }): Promise<string> {
    const ws = opts.workspaceId ?? workspaceId;
    const name = `brief-lab-${repoSeq++}`;
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId: ws, owner: 'acme', name, fullName: `acme/${name}` })
      .returning();
    const [pull] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId: ws,
        repoId: repo!.id,
        number: 900 + repoSeq,
        title: 'Add rate limiting to public API endpoints',
        author: 'marisa.koch',
        branch: 'feat/rate-limit-public',
        base: 'main',
        headSha: opts.headSha ?? 'sha-1',
        additions: 41,
        deletions: 0,
        filesCount: opts.files?.length ?? 0,
        status: 'open',
        body: opts.body === undefined ? 'Adds a per-IP limiter. Closes #471.' : opts.body,
      })
      .returning();
    for (const f of opts.files ?? []) {
      await pg.handle.db.insert(t.prFiles).values({ prId: pull!.id, ...f });
    }
    return pull!.id;
  }

  /** A PR reviewed once, at `score`, so the deterministic header can be asserted. */
  async function prWithScore(score: number): Promise<string> {
    const id = await makePr({
      files: [{ path: 'src/config.ts', additions: 1, deletions: 0, patch: PATCH_CONFIG }],
    });
    await pg.handle.db.insert(t.reviews).values({
      workspaceId,
      prId: id,
      agentId: randomUUID(),
      kind: 'review',
      verdict: 'comment',
      score,
    });
    return id;
  }

  function makeApp(llm: LLMProvider, github: MockGitHubClient = new MockGitHubClient()) {
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        github,
        git: new MockGitClient(),
        llm: { openai: llm },
      },
    });
  }

  beforeAll(async () => {
    pg = await startPg();
    const seeded = await seed(pg.handle.db);
    workspaceId = seeded.workspaceId;

    prId = await makePr({
      files: [
        { path: 'src/config.ts', additions: 1, deletions: 0, patch: PATCH_CONFIG },
        {
          path: 'src/middleware/ratelimit.ts',
          additions: 40,
          deletions: 0,
          patch: PATCH_RATELIMIT,
        },
      ],
    });

    // Two priced review runs. `agent_runs.agent_id` has a real FK, so it is left
    // null; `reviews.agent_id` has none, which is what the per-agent rollup keys on.
    const [runApprove] = await pg.handle.db
      .insert(t.agentRuns)
      .values({
        workspaceId,
        prId,
        status: 'done',
        costUsd: 0.02,
        tokensIn: 1000,
        tokensOut: 100,
        blockers: 0,
        findingsCount: 1,
      })
      .returning();
    const [runChanges] = await pg.handle.db
      .insert(t.agentRuns)
      .values({
        workspaceId,
        prId,
        status: 'done',
        costUsd: 0.03,
        tokensIn: 2000,
        tokensOut: 200,
        blockers: 2,
        findingsCount: 2,
      })
      .returning();

    agentAId = randomUUID();
    agentBId = randomUUID();
    const [reviewA] = await pg.handle.db
      .insert(t.reviews)
      .values({
        workspaceId,
        prId,
        agentId: agentAId,
        runId: runApprove!.id,
        kind: 'review',
        verdict: 'approve',
        summary: 'Looks fine to me.',
        score: 100,
      })
      .returning();
    const [reviewB] = await pg.handle.db
      .insert(t.reviews)
      .values({
        workspaceId,
        prId,
        agentId: agentBId,
        runId: runChanges!.id,
        kind: 'review',
        verdict: 'request_changes',
        summary: 'Secret in config.',
        score: 61,
      })
      .returning();

    // A `summary` row must NOT reach the rollup — the repository's `kind` filter
    // is what keeps it out, so one is planted here on purpose.
    await pg.handle.db.insert(t.reviews).values({
      workspaceId,
      prId,
      agentId: randomUUID(),
      kind: 'summary',
      verdict: 'approve',
      score: 5,
    });

    const [critical] = await pg.handle.db
      .insert(t.findings)
      .values({
        reviewId: reviewB!.id,
        file: 'src/config.ts',
        startLine: 11,
        endLine: 11,
        severity: 'CRITICAL',
        category: 'security',
        title: 'Hardcoded Stripe secret key',
        rationale: 'A live key is committed in source.',
        confidence: 0.95,
      })
      .returning();
    criticalFindingId = critical!.id;
    await pg.handle.db.insert(t.findings).values([
      {
        reviewId: reviewB!.id,
        file: 'src/config.ts',
        startLine: 12,
        endLine: 12,
        severity: 'WARNING',
        category: 'bug',
        title: 'Redis URL unvalidated',
        rationale: 'No parse before use.',
        confidence: 0.6,
      },
      {
        reviewId: reviewA!.id,
        file: 'src/middleware/ratelimit.ts',
        startLine: 5,
        endLine: 5,
        severity: 'SUGGESTION',
        category: 'style',
        title: 'Extract the bucket size',
        rationale: 'Magic number.',
        confidence: 0.4,
      },
    ]);

    // A priced intent classification — the third term of the AC-9 cost sum.
    await pg.handle.db.insert(t.prIntent).values({
      prId,
      intent: 'Introduce per-IP rate limiting on the public API endpoints.',
      inScope: ['Token-bucket middleware'],
      outOfScope: ['Auth changes'],
      riskAreas: ['New dependency: ioredis'],
      confidence: 'high',
      sources: [{ kind: 'pr_description', ref: 'PR description', status: 'fetched' }],
      model: 'google/gemini-2.5-flash-lite',
      headSha: 'sha-1',
      tokensIn: 500,
      tokensOut: 50,
      costUsd: 0.01,
    });
  });

  afterAll(async () => {
    await pg?.stop();
  });

  // ---------------------------------------------------------------- A: cache

  it('AC-1 · AC-15 · AC-16 · AC-16a — the first POST generates with exactly ONE model call and a deterministic header', async () => {
    const llm = briefLlm(GEN_A);
    const app = await makeApp(llm);

    const res = await app.inject({ method: 'POST', url: `/pulls/${prId}/brief` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PrBriefDetail;

    // AC-1 — exactly one structured call, and it is THIS feature's schema.
    const calls = structuredCalls(llm);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.req as { schemaName: string }).schemaName).toBe('PrBriefGeneration');

    // Model content, post-grounding (nothing was ungroundable here).
    expect(body.generation).toEqual({ state: 'ok', reason: null });
    expect(body.what).toBe(GEN_A.what);
    expect(body.why).toBe(GEN_A.why);
    expect(body.risks).toHaveLength(1);
    expect(body.review_focus).toHaveLength(1);

    // AC-15 — worst verdict across the per-agent-latest reviews wins:
    // `approve` (agent A) + `request_changes` (agent B) ⇒ request_changes.
    expect(body.status).toBe('request_changes');
    // AC-16 — lowest deterministic score across those reviews: min(100, 61).
    // The planted `kind = 'summary'` row (score 5) must not participate.
    expect(body.score).toBe(61);
    // AC-16a — 61 sits in 50–74 ⇒ medium, derived server-side, never from the model.
    expect(body.risk_level).toBe('medium');
    // AC-17 — findings summed across those reviews, blockers summed per run.
    expect(body.findings_count).toBe(3);
    expect(body.blockers).toBe(2);

    // Provenance is present and the freshly written brief is never stale.
    expect(body.head_sha).toBe('sha-1');
    expect(body.model).toBeTruthy();
    expect(body.generated_at).toBeTruthy();
    expect(body.stale).toBe(false);
    expect(body.stale_reason).toBeNull();

    // Exactly one persisted row for the PR.
    const rows = await pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, prId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.headSha).toBe('sha-1');
    expect(rows[0]!.fingerprint).toBeTruthy();

    // AC-16, the literal observable: the card's gauge equals the score the PR
    // LIST shows for the same PR. Both go through `_shared/review-rollup`, so
    // this is parity by construction — asserted here so a future divergence
    // between the two consumers fails a test rather than a user's expectation.
    const [pull] = await pg.handle.db
      .select()
      .from(t.pullRequests)
      .where(eq(t.pullRequests.id, prId));
    const list = (
      await app.inject({ method: 'GET', url: `/repos/${pull!.repoId}/pulls` })
    ).json() as { number: number; score: number | null }[];
    expect(list.find((p) => p.number === pull!.number)?.score).toBe(body.score);

    await app.close();
  });

  it('AC-3 · NFR-4 — a second GET in the same state is byte-identical and adds no model call and no cost', async () => {
    const llm = briefLlm(GEN_A);
    const app = await makeApp(llm);

    const first = await app.inject({ method: 'GET', url: `/pulls/${prId}/brief` });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'GET', url: `/pulls/${prId}/brief` });

    // AC-3 — identical payloads, asserted on the raw bytes.
    expect(second.body).toBe(first.body);
    // NFR-4 — an unchanged PR state costs $0.00 additional: zero model calls.
    expect(structuredCalls(llm)).toHaveLength(0);

    const body = first.json() as PrBriefDetail;
    expect(body.generation).toEqual({ state: 'ok', reason: null });
    expect(body.what).toBe(GEN_A.what);
    expect(body.stale).toBe(false);

    await app.close();
  });

  it('AC-41 — dismissing a finding leaves the brief payload byte-identical and `stale` false', async () => {
    const llm = briefLlm(GEN_A);
    const app = await makeApp(llm);

    const before = await app.inject({ method: 'GET', url: `/pulls/${prId}/brief` });
    expect((before.json() as PrBriefDetail).stale).toBe(false);

    const dismissed = await app.inject({
      method: 'POST',
      url: `/findings/${criticalFindingId}/dismiss`,
    });
    expect(dismissed.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: `/pulls/${prId}/brief` });
    // The cache fingerprint has no field for a finding ACTION, so triaging can
    // neither stale the brief nor move `findings_count`.
    expect(after.body).toBe(before.body);
    expect((after.json() as PrBriefDetail).stale).toBe(false);
    expect(structuredCalls(llm)).toHaveLength(0);

    await app.close();
  });

  it('AC-4 · AC-5 — a new review run flips `stale` with a reason, with no model call and no new cost', async () => {
    const llm = briefLlm(GEN_A);
    const app = await makeApp(llm);

    const before = (await app.inject({ method: 'GET', url: `/pulls/${prId}/brief` }))
      .json() as PrBriefDetail;
    expect(before.stale).toBe(false);

    // Agent A re-reviews on the SAME head SHA. `runId` is left null so the run
    // contributes no cost — staleness must come from the review-id set alone.
    await pg.handle.db.insert(t.reviews).values({
      workspaceId,
      prId,
      agentId: agentAId,
      kind: 'review',
      verdict: 'approve',
      summary: 'Re-reviewed.',
      score: 100,
    });

    const after = (await app.inject({ method: 'GET', url: `/pulls/${prId}/brief` }))
      .json() as PrBriefDetail;

    // AC-4 — the fingerprint covers the per-agent-latest review id set, so a new
    // run on an unchanged head SHA is a state change.
    expect(after.stale).toBe(true);
    // AC-5 — reported with a human-readable reason, and NOT regenerated.
    expect(after.stale_reason).toBeTruthy();
    expect(after.stale_reason).toMatch(/inputs changed/i);
    expect(structuredCalls(llm)).toHaveLength(0);
    expect(after.cost_usd).toBe(before.cost_usd);
    // The stale brief still serves its previous content (N5: flagged, not blanked).
    expect(after.what).toBe(GEN_A.what);
    expect(after.generated_at).toBe(before.generated_at);

    // AC-4, the other half of the cache key: moving ONLY the head SHA is also a
    // state change, and the reason names the SHA move specifically.
    await pg.handle.db
      .update(t.pullRequests)
      .set({ headSha: 'sha-2' })
      .where(eq(t.pullRequests.id, prId));
    const moved = (await app.inject({ method: 'GET', url: `/pulls/${prId}/brief` }))
      .json() as PrBriefDetail;
    expect(moved.stale).toBe(true);
    expect(moved.stale_reason).toMatch(/head moved from sha-1 to sha-2/);
    expect(structuredCalls(llm)).toHaveLength(0);

    await app.close();
  });

  it('AC-6 — POST again replaces the cached entry wholesale', async () => {
    const llm = briefLlm(GEN_B);
    const app = await makeApp(llm);

    const res = await app.inject({ method: 'POST', url: `/pulls/${prId}/brief` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PrBriefDetail;

    // Every section reflects the new generation; nothing is retained from GEN_A.
    expect(body.what).toBe(GEN_B.what);
    expect(body.why).toBe(GEN_B.why);
    expect(body.risks).toHaveLength(1);
    expect(body.risks[0]!.title).toBe(GEN_B.risks[0]!.title);
    expect(body.review_focus).toHaveLength(1);
    expect(body.review_focus[0]!.path).toBe('src/middleware/ratelimit.ts');
    expect(JSON.stringify(body)).not.toContain(GEN_A.what);
    expect(JSON.stringify(body)).not.toContain(GEN_A.risks[0]!.title);
    // Regenerating re-anchors the brief to the current state (the previous test
    // moved the head to `sha-2`), so the stale flag clears.
    expect(body.stale).toBe(false);
    expect(body.head_sha).toBe('sha-2');

    // Still ONE row — an upsert in place, never a second cached entry.
    const rows = await pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, prId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.json).toMatchObject({ what: GEN_B.what, why: GEN_B.why });

    // The read-back GET agrees with what POST returned.
    const get = (await app.inject({ method: 'GET', url: `/pulls/${prId}/brief` }))
      .json() as PrBriefDetail;
    expect(get.what).toBe(GEN_B.what);
    expect(get.stale).toBe(false);

    await app.close();
  });

  it('AC-9 — the cost total is the sum of review runs + intent + brief', async () => {
    const app = await makeApp(briefLlm(GEN_B));

    const body = (await app.inject({ method: 'GET', url: `/pulls/${prId}/brief` }))
      .json() as PrBriefDetail;

    const runs = await pg.handle.db.select().from(t.agentRuns).where(eq(t.agentRuns.prId, prId));
    const [intent] = await pg.handle.db.select().from(t.prIntent).where(eq(t.prIntent.prId, prId));
    const [brief] = await pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, prId));

    const entries = [...runs, intent!, brief!];
    const sum = (pick: (e: { costUsd: number | null; tokensIn: number | null; tokensOut: number | null }) => number | null) =>
      entries.reduce((acc, e) => acc + (pick(e) ?? 0), 0);

    // The arithmetic SUM across all four calls, not the latest one.
    expect(body.cost_usd).toBeCloseTo(sum((e) => e.costUsd), 10);
    expect(body.cost_usd).toBeCloseTo(0.02 + 0.03 + 0.01 + (brief!.costUsd ?? 0), 10);
    expect(body.tokens_in).toBe(sum((e) => e.tokensIn));
    expect(body.tokens_out).toBe(sum((e) => e.tokensOut));
    // The brief's own generation is inside the total (AC-8).
    expect(brief!.costUsd).not.toBeNull();
    expect(body.cost_usd!).toBeGreaterThan(0.06);

    await app.close();
  });

  // ------------------------------------------------------- C: header rollup

  it('AC-16a edge — a score sitting exactly on a band boundary belongs to the HIGHER band', async () => {
    const app = await makeApp(briefLlm(GEN_A));

    // 75 and 50 are the gauge's own breakpoints (`>= 75`, `>= 50`).
    const cases: [number, string][] = [
      [75, 'low'],
      [74, 'medium'],
      [50, 'medium'],
      [49, 'high'],
    ];
    for (const [score, level] of cases) {
      const id = await prWithScore(score);
      const body = (await app.inject({ method: 'GET', url: `/pulls/${id}/brief` }))
        .json() as PrBriefDetail;
      expect(body.score).toBe(score);
      expect(body.risk_level).toBe(level);
      // A reviewed PR with no cached brief is `not_generated`, never a 404.
      expect(body.generation.state).toBe('not_generated');
    }

    await app.close();
  });

  it('AC-18 · AC-18a — an unreviewed PR still generates prose but reports not_reviewed, a null score and no risk level', async () => {
    const llm = briefLlm(GEN_A);
    const app = await makeApp(llm);
    const id = await makePr({
      files: [{ path: 'src/config.ts', additions: 1, deletions: 0, patch: PATCH_CONFIG }],
    });

    const body = (await app.inject({ method: 'POST', url: `/pulls/${id}/brief` }))
      .json() as PrBriefDetail;

    // AC-18 — no completed review run ⇒ not_reviewed, null score, zero counts.
    expect(body.status).toBe('not_reviewed');
    expect(body.score).toBeNull();
    expect(body.findings_count).toBe(0);
    expect(body.blockers).toBe(0);
    // AC-18a — no score ⇒ no risk level (the gauge is omitted client-side).
    expect(body.risk_level).toBeNull();
    // …and the generation still ran: prose, risks and focus are all present.
    expect(body.generation.state).toBe('ok');
    expect(body.what).toBe(GEN_A.what);
    expect(body.risks).toHaveLength(1);
    expect(body.review_focus).toHaveLength(1);
    expect(structuredCalls(llm)).toHaveLength(1);
    // AC-34 — the absence of a review is reported as a missing input, honestly.
    expect(body.missing_inputs.map((m) => m.input)).toContain('reviews');

    await app.close();
  });

  // -------------------------------------------------------- B: grounding gate

  it('AC-11 · AC-12 — an invented path and an unchanged line are dropped BEFORE the brief is persisted', async () => {
    const llm = briefLlm(GEN_UNGROUNDED);
    const app = await makeApp(llm);
    const id = await makePr({
      files: [{ path: 'src/config.ts', additions: 1, deletions: 0, patch: PATCH_CONFIG }],
    });

    const body = (await app.inject({ method: 'POST', url: `/pulls/${id}/brief` }))
      .json() as PrBriefDetail;
    expect(body.generation.state).toBe('ok');

    // AC-11 — the risk whose only ref is an invented path is gone; the real one stays.
    expect(body.risks).toHaveLength(1);
    expect(body.risks[0]!.title).toBe('Real risk on a real file');
    // AC-12 — of three focus entries only the changed line of a changed file survives.
    expect(body.review_focus).toHaveLength(1);
    expect(body.review_focus[0]).toMatchObject({ path: 'src/config.ts', line: 11 });

    // The drop happens BEFORE persistence — the stored blob carries no trace.
    const [row] = await pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, id));
    const stored = JSON.stringify(row!.json);
    expect(stored).not.toContain('src/totally/invented.ts');
    expect(stored).not.toContain('UNCHANGED line');

    await app.close();
  });

  // --------------------------------------------- F: failures & prerequisites

  it('AC-32 — a PR with no classified intent still generates, and names intent as a missing input', async () => {
    const llm = briefLlm(GEN_A);
    const app = await makeApp(llm);
    // No `pr_intent` row is inserted for this PR — it was never classified.
    const id = await makePr({
      files: [{ path: 'src/config.ts', additions: 1, deletions: 0, patch: PATCH_CONFIG }],
    });

    const body = (await app.inject({ method: 'POST', url: `/pulls/${id}/brief` }))
      .json() as PrBriefDetail;

    // The generation proceeds from the remaining inputs rather than refusing.
    expect(body.generation.state).toBe('ok');
    expect(body.what).toBe(GEN_A.what);
    expect(structuredCalls(llm)).toHaveLength(1);

    // …and the absence is reported honestly rather than silently absorbed.
    const note = body.missing_inputs.find((m) => m.input === 'intent');
    expect(note?.reason).toMatch(/classified/i);

    // Non-vacuous: the primary PR DOES have an intent row and reports no such
    // note, so the assertion above is about this PR's state, not about a note
    // every brief carries.
    const classified = (await app.inject({ method: 'GET', url: `/pulls/${prId}/brief` }))
      .json() as PrBriefDetail;
    expect(classified.missing_inputs.map((m) => m.input)).not.toContain('intent');

    await app.close();
  });

  it("AC-33 — a degraded/empty blast records a blast_radius note carrying the blast's own reason", async () => {
    const app = await makeApp(briefLlm(GEN_A));
    const id = await makePr({
      files: [{ path: 'src/config.ts', additions: 1, deletions: 0, patch: PATCH_CONFIG }],
    });

    // The repository is never indexed in this suite, so the blast slice returns a
    // DECLARED non-ok response with its own human-readable reason.
    const blast = (await app.inject({ method: 'GET', url: `/pulls/${id}/blast` })).json() as {
      status: string;
      reason?: string | null;
    };
    expect(['degraded', 'empty']).toContain(blast.status);
    expect(blast.reason).toBeTruthy();

    const body = (await app.inject({ method: 'POST', url: `/pulls/${id}/brief` }))
      .json() as PrBriefDetail;
    expect(body.generation.state).toBe('ok');

    // The note carries the blast's OWN reason verbatim — the card tells the user
    // what to fix (index the repository), not a generic "unavailable".
    const note = body.missing_inputs.find((m) => m.input === 'blast_radius');
    expect(note?.reason).toBe(blast.reason);

    // The narrowing half of AC-33 is covered hermetically in brief-helpers.test.ts.
    await app.close();
  });

  it('a one-time missing-input note survives the next GET (linked_issue; AC-32 precedent)', async () => {
    const llm = briefLlm(GEN_A);
    // Q4 re-fetches the linked issue per generation; this client makes it fail.
    const app = await makeApp(llm, new IssueFetchFailingGitHubClient());
    const id = await makePr({
      files: [{ path: 'src/config.ts', additions: 1, deletions: 0, patch: PATCH_CONFIG }],
      body: 'Adds a per-IP limiter. Closes #471.',
    });

    const posted = (await app.inject({ method: 'POST', url: `/pulls/${id}/brief` }))
      .json() as PrBriefDetail;
    expect(posted.generation.state).toBe('ok');
    const postedNote = posted.missing_inputs.find((m) => m.input === 'linked_issue');
    expect(postedNote?.reason).toContain('#471');

    // The regression this guards: a read cannot recompute a failed fetch, so
    // without persistence the note appeared once in the POST response and then
    // silently vanished — even though the cached brief really was generated
    // without the issue.
    const got = (await app.inject({ method: 'GET', url: `/pulls/${id}/brief` }))
      .json() as PrBriefDetail;
    expect(got.stale).toBe(false);
    expect(got.what).toBe(GEN_A.what);
    expect(got.missing_inputs.find((m) => m.input === 'linked_issue')).toEqual(postedNote);
    // Reporting it costs nothing: the GET is still a cached read (AC-3).
    expect(structuredCalls(llm)).toHaveLength(1);

    const [row] = await pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, id));
    expect(row!.missingInputs).toContainEqual(postedNote);

    await app.close();
  });

  it('AC-14 — a fixture over the cardinality cap is rejected and NO row is written', async () => {
    const llm = briefLlm(GEN_OVER_CAP);
    const app = await makeApp(llm);
    const id = await makePr({
      files: [{ path: 'src/config.ts', additions: 1, deletions: 0, patch: PATCH_CONFIG }],
    });

    const res = await app.inject({ method: 'POST', url: `/pulls/${id}/brief` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PrBriefDetail;

    // The caps live ON the schema, so the provider's own parse rejects the
    // response (MockLLMProvider throws) and the service fails closed.
    expect(structuredCalls(llm)).toHaveLength(1);
    expect(body.generation.state).toBe('failed');
    expect(body.what).toBeNull();
    expect(body.risks).toEqual([]);
    expect(body.review_focus).toEqual([]);

    const rows = await pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, id));
    expect(rows).toHaveLength(0);

    await app.close();
  });

  it('AC-36 — a failing provider still returns the full deterministic header and persists nothing', async () => {
    const llm = new ExplodingLLMProvider();
    const app = await makeApp(llm);
    const id = await makePr({
      files: [{ path: 'src/config.ts', additions: 1, deletions: 0, patch: PATCH_CONFIG }],
    });
    await pg.handle.db.insert(t.reviews).values({
      workspaceId,
      prId: id,
      agentId: randomUUID(),
      kind: 'review',
      verdict: 'comment',
      score: 61,
    });

    const res = await app.inject({ method: 'POST', url: `/pulls/${id}/brief` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PrBriefDetail;

    expect(llm.structuredCalls).toBe(1);
    expect(body.generation.state).toBe('failed');
    expect(body.generation.reason).toContain('provider unreachable');
    // NFR-7 — the header is computed from persisted review data, so it is fully
    // correct even though the generation failed: gauge included.
    expect(body.status).toBe('comment');
    expect(body.score).toBe(61);
    expect(body.risk_level).toBe('medium');
    // Nothing partial or fabricated is served or stored.
    expect(body.what).toBeNull();
    expect(body.why).toBeNull();
    expect(body.model).toBeNull();
    expect(body.head_sha).toBeNull();
    const rows = await pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, id));
    expect(rows).toHaveLength(0);

    await app.close();
  });

  it('AC-35 — a PR with no recorded changed files is `unavailable`, with ZERO model calls', async () => {
    const llm = briefLlm(GEN_A);
    const app = await makeApp(llm);
    const id = await makePr({ files: [] });

    const res = await app.inject({ method: 'POST', url: `/pulls/${id}/brief` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PrBriefDetail;

    expect(body.generation.state).toBe('unavailable');
    expect(body.generation.reason).toMatch(/no changed files/i);
    // The refusal happens BEFORE the provider is touched at all.
    expect(llm.calls).toHaveLength(0);
    expect(body.missing_inputs.map((m) => m.input)).toContain('changed_files');

    const rows = await pg.handle.db.select().from(t.prBrief).where(eq(t.prBrief.prId, id));
    expect(rows).toHaveLength(0);

    await app.close();
  });

  it('AC-37 — a cross-workspace request is byte-identical to a nonexistent PR, on both verbs', async () => {
    const llm = briefLlm(GEN_A);
    const app = await makeApp(llm);

    const [otherWs] = await pg.handle.db
      .insert(t.workspaces)
      .values({ name: 'other-tenant' })
      .returning();
    const foreignPrId = await makePr({
      workspaceId: otherWs!.id,
      files: [{ path: 'src/config.ts', additions: 1, deletions: 0, patch: PATCH_CONFIG }],
    });
    const NONEXISTENT = '00000000-0000-0000-0000-000000000000';

    const foreignGet = await app.inject({ method: 'GET', url: `/pulls/${foreignPrId}/brief` });
    const missingGet = await app.inject({ method: 'GET', url: `/pulls/${NONEXISTENT}/brief` });
    expect(foreignGet.statusCode).toBe(404);
    expect(missingGet.statusCode).toBe(404);
    // Byte identity, not merely "both are 404" — nothing discloses existence.
    expect(foreignGet.body).toBe(missingGet.body);

    const foreignPost = await app.inject({ method: 'POST', url: `/pulls/${foreignPrId}/brief` });
    const missingPost = await app.inject({ method: 'POST', url: `/pulls/${NONEXISTENT}/brief` });
    expect(foreignPost.statusCode).toBe(404);
    expect(missingPost.statusCode).toBe(404);
    expect(foreignPost.body).toBe(missingPost.body);

    // The denial is fail-closed: no model call, nothing written for the foreign PR.
    expect(llm.calls).toHaveLength(0);
    const rows = await pg.handle.db
      .select()
      .from(t.prBrief)
      .where(eq(t.prBrief.prId, foreignPrId));
    expect(rows).toHaveLength(0);

    await app.close();
  });
});
