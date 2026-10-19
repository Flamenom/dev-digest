import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Review } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { waitForPrRuns } from './helpers/runs.js';
import { buildGoogleApp, asSession, asToken, type GoogleTestApp, type TestUser } from './helpers/google-mode.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { MockLLMProvider, MockEmbedder, MockGitClient } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';
import { auditWritesSettled } from '../src/platform/auth/audit-hook.js';

/**
 * T24 — reviews attribution + cancel ownership (Postgres):
 *   AC-45 run initiator → `started_by` on runs + reviews (session AND bearer token)
 *   AC-46 finding actor → `acted_by` (latest) + one audit row per action
 *   AC-30 Member cancels someone else's / a legacy run → 403; Admin → 200
 *   AC-49 local mode → the seeded system user (`is_system: true`)
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const DIFF = `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -10,3 +10,4 @@
   port: 3000,
+  stripeKey: "sk_live_xxx",
   redisUrl: x,`;

const REVIEW: Review = {
  verdict: 'request_changes',
  summary: 'Hardcoded secret.',
  score: 40,
  findings: [
    {
      id: 'f-1',
      severity: 'CRITICAL',
      category: 'security',
      title: 'Hardcoded Stripe secret key',
      file: 'src/config.ts',
      start_line: 11,
      end_line: 11,
      rationale: 'A live key is committed.',
      suggestion: 'Use an env var.',
      confidence: 0.95,
      kind: 'finding',
    },
  ],
};

const overrides = () => ({
  embedder: new MockEmbedder(),
  git: new MockGitClient({ diff: DIFF }),
  llm: { openai: new MockLLMProvider('openai', { structured: REVIEW }) },
});

let seq = 0;
async function setupPr(db: PgFixture['handle']['db'], workspaceId: string) {
  const name = `attr-api-${seq++}`;
  const [repo] = await db
    .insert(t.repos)
    .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}` })
    .returning();
  const [pr] = await db
    .insert(t.pullRequests)
    .values({
      workspaceId,
      repoId: repo!.id,
      number: 7,
      title: 'Add config',
      author: 'dev',
      branch: 'feat/x',
      base: 'main',
      headSha: 'abc123',
      additions: 1,
      deletions: 0,
      filesCount: 1,
      status: 'needs_review',
      body: '',
    })
    .returning();
  await db.insert(t.prFiles).values({
    prId: pr!.id,
    path: 'src/config.ts',
    additions: 1,
    deletions: 0,
    patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,',
  });
  const [agent] = await db
    .insert(t.agents)
    .values({ workspaceId, name: `Sec ${seq}`, provider: 'openai', model: 'gpt-4.1', systemPrompt: 'sec' })
    .returning();
  return { pr: pr!, agent: agent! };
}

async function insertRunningRun(
  db: PgFixture['handle']['db'],
  workspaceId: string,
  prId: string,
  initiatedBy: string | null,
): Promise<string> {
  const [row] = await db
    .insert(t.agentRuns)
    .values({ workspaceId, prId, status: 'running', source: 'local', initiatedBy })
    .returning({ id: t.agentRuns.id });
  return row!.id;
}

d('T24 reviews attribution (google mode)', () => {
  let pg: PgFixture;
  let g: GoogleTestApp;
  let alice: TestUser;
  let bob: TestUser;
  let admin: TestUser;
  let aliceCookie: Awaited<ReturnType<GoogleTestApp['signIn']>>;
  let bobCookie: Awaited<ReturnType<GoogleTestApp['signIn']>>;
  let adminCookie: Awaited<ReturnType<GoogleTestApp['signIn']>>;

  beforeAll(async () => {
    pg = await startPg();
    g = await buildGoogleApp({ pg, overrides: overrides() });
    alice = await g.createUser({ name: 'Alice', role: 'member' });
    bob = await g.createUser({ name: 'Bob', role: 'member' });
    admin = await g.createUser({ name: 'Ada Admin', role: 'admin' });
    [aliceCookie, bobCookie, adminCookie] = await Promise.all([
      g.signIn(alice),
      g.signIn(bob),
      g.signIn(admin),
    ]);
  }, 120_000);

  afterAll(async () => {
    await g?.close();
    await pg?.stop();
  });

  it('records the initiator (session) → started_by on runs and reviews (AC-45)', async () => {
    const { pr, agent } = await setupPr(g.db, g.workspaceId);
    const res = await g.app.inject(
      asSession(aliceCookie, { method: 'POST', url: `/pulls/${pr.id}/review`, payload: { agentId: agent.id } }),
    );
    expect(res.statusCode).toBe(200);
    await waitForPrRuns(g.db, pr.id, { expected: 1 });

    const runs = (await g.app.inject(asSession(bobCookie, { method: 'GET', url: `/pulls/${pr.id}/runs` }))).json();
    expect(runs).toHaveLength(1);
    expect(runs[0].started_by).toEqual({ user_id: alice.userId, name: 'Alice' });
    expect(runs[0]).not.toHaveProperty('initiatedBy');

    const reviews = (
      await g.app.inject(asSession(bobCookie, { method: 'GET', url: `/pulls/${pr.id}/reviews` }))
    ).json();
    expect(reviews).toHaveLength(1);
    expect(reviews[0].started_by).toEqual({ user_id: alice.userId, name: 'Alice' });
    expect(reviews[0].findings[0].acted_by).toBeNull();
  });

  it('a bearer-token run (MCP) is attributed to the token owner', async () => {
    const { pr, agent } = await setupPr(g.db, g.workspaceId);
    const tok = await g.createToken(bob);
    const res = await g.app.inject(
      asToken(tok, { method: 'POST', url: `/pulls/${pr.id}/review`, payload: { agentId: agent.id } }),
    );
    expect(res.statusCode).toBe(200);
    await waitForPrRuns(g.db, pr.id, { expected: 1 });
    const runs = (await g.app.inject(asToken(tok, { method: 'GET', url: `/pulls/${pr.id}/runs` }))).json();
    expect(runs[0].started_by).toEqual({ user_id: bob.userId, name: 'Bob' });
  });

  it('A accepts, B dismisses → acted_by = B and two audit rows (AC-46)', async () => {
    const { pr, agent } = await setupPr(g.db, g.workspaceId);
    await g.app.inject(
      asSession(aliceCookie, { method: 'POST', url: `/pulls/${pr.id}/review`, payload: { agentId: agent.id } }),
    );
    await waitForPrRuns(g.db, pr.id, { expected: 1 });
    const [review] = (
      await g.app.inject(asSession(aliceCookie, { method: 'GET', url: `/pulls/${pr.id}/reviews` }))
    ).json();
    const findingId: string = review.findings[0].id;

    const acc = await g.app.inject(
      asSession(aliceCookie, { method: 'POST', url: `/findings/${findingId}/accept` }),
    );
    expect(acc.statusCode).toBe(200);
    expect(acc.json().finding.acted_by).toEqual({ user_id: alice.userId, name: 'Alice' });

    const dis = await g.app.inject(asSession(bobCookie, { method: 'POST', url: `/findings/${findingId}/dismiss` }));
    expect(dis.statusCode).toBe(200);
    expect(dis.json().finding.acted_by).toEqual({ user_id: bob.userId, name: 'Bob' });

    const [after] = (
      await g.app.inject(asSession(aliceCookie, { method: 'GET', url: `/pulls/${pr.id}/reviews` }))
    ).json();
    expect(after.findings[0].acted_by).toEqual({ user_id: bob.userId, name: 'Bob' });
    expect(after.findings[0].dismissed_at).not.toBeNull();
    expect(after.findings[0].accepted_at).toBeNull();

    // The audit hook (T21) writes one row per action — not duplicated by the module.
    // Written after the response (onResponse) → wait for in-flight writes.
    await auditWritesSettled(g.app);
    const audit = await g.db
      .select()
      .from(t.auditEvents)
      .where(and(eq(t.auditEvents.workspaceId, g.workspaceId), eq(t.auditEvents.targetId, findingId)));
    expect(audit.map((a) => [a.action, a.actorUserId]).sort()).toEqual(
      [
        ['finding.accept', alice.userId],
        ['finding.dismiss', bob.userId],
      ].sort(),
    );
  });

  it("Member can't cancel another user's or a legacy run; initiator and Admin can (AC-30)", async () => {
    const { pr } = await setupPr(g.db, g.workspaceId);
    const alicesRun = await insertRunningRun(g.db, g.workspaceId, pr.id, alice.userId);
    const legacyRun = await insertRunningRun(g.db, g.workspaceId, pr.id, null);
    const ownRun = await insertRunningRun(g.db, g.workspaceId, pr.id, bob.userId);
    const cancel = (cookie: typeof bobCookie, runId: string) =>
      g.app.inject(asSession(cookie, { method: 'POST', url: `/runs/${runId}/cancel` }));
    const statusOf = async (runId: string) =>
      (await g.db.select({ s: t.agentRuns.status }).from(t.agentRuns).where(eq(t.agentRuns.id, runId)))[0]!.s;

    const denied = await cancel(bobCookie, alicesRun);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error?.code ?? denied.json().code).toBe('forbidden_owner');
    expect(await statusOf(alicesRun)).toBe('running');

    expect((await cancel(bobCookie, legacyRun)).statusCode).toBe(403);
    expect(await statusOf(legacyRun)).toBe('running');

    expect((await cancel(bobCookie, ownRun)).statusCode).toBe(200);
    expect(await statusOf(ownRun)).toBe('cancelled');

    expect((await cancel(adminCookie, alicesRun)).statusCode).toBe(200);
    expect(await statusOf(alicesRun)).toBe('cancelled');
    expect((await cancel(adminCookie, legacyRun)).statusCode).toBe(200);

    // legacy run renders "—"
    const runs = (await g.app.inject(asSession(adminCookie, { method: 'GET', url: `/pulls/${pr.id}/runs` }))).json();
    const legacy = runs.find((r: { run_id: string }) => r.run_id === legacyRun);
    expect(legacy.started_by).toBeNull();
  });
});

d('T24 reviews attribution (local mode, AC-49)', () => {
  let pg: PgFixture;

  beforeAll(async () => {
    pg = await startPg();
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });

  it('every recorded actor is the seeded system user (is_system)', async () => {
    // buildGoogleApp only to bootstrap the tenancy rows + learn the system user id.
    const g = await buildGoogleApp({ pg });
    const { workspaceId, systemUserId } = g;
    await g.close();

    const app = await buildApp({
      config: loadConfig({ ...process.env, NODE_ENV: 'test', AUTH_MODE: 'local' } as NodeJS.ProcessEnv),
      db: pg.handle.db,
      overrides: overrides(),
    });
    const { pr, agent } = await setupPr(pg.handle.db, workspaceId);
    expect(
      (await app.inject({ method: 'POST', url: `/pulls/${pr.id}/review`, payload: { agentId: agent.id } })).statusCode,
    ).toBe(200);
    await waitForPrRuns(pg.handle.db, pr.id, { expected: 1 });

    const [run] = (await app.inject({ method: 'GET', url: `/pulls/${pr.id}/runs` })).json();
    expect(run.started_by).toMatchObject({ user_id: systemUserId, is_system: true });

    const [review] = (await app.inject({ method: 'GET', url: `/pulls/${pr.id}/reviews` })).json();
    const res = await app.inject({ method: 'POST', url: `/findings/${review.findings[0].id}/accept` });
    expect(res.json().finding.acted_by).toMatchObject({ user_id: systemUserId, is_system: true });

    // local mode: the system user is Admin → may cancel any run, incl. legacy ones
    const legacyRun = await insertRunningRun(pg.handle.db, workspaceId, pr.id, null);
    expect((await app.inject({ method: 'POST', url: `/runs/${legacyRun}/cancel` })).statusCode).toBe(200);
    await app.close();
  });
});
