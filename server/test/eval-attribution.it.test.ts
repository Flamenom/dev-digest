import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { asSession, buildGoogleApp, type GoogleTestApp, type SessionCredential, type TestUser } from './helpers/google-mode.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient, MockLLMProvider } from '../src/adapters/mocks.js';
import type { EvalExpectedOutput } from '@devdigest/shared';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;
if (!hasDocker) console.warn('[eval-attribution] Docker not available — skipping integration tests.');

/**
 * Multi-user T25 — eval case creator + edit/delete ownership over real Postgres.
 *
 *  · AC-47: every create path records `eval_cases.created_by` and the DTO
 *    carries `created_by` (ActorRef) on create / read / list / update;
 *  · AC-30: PUT/DELETE are "Member own / Admin any"; a legacy case (no
 *    creator) is Admin-only; a refused request changes nothing;
 *  · AC-31: Members see each other's cases (no per-user visibility filter);
 *  · AC-49: local mode attributes to the seeded system user (`is_system`).
 */
d('eval case attribution (integration, google mode)', () => {
  let pg: PgFixture;
  let g: GoogleTestApp;
  let admin: TestUser;
  let alice: TestUser;
  let bob: TestUser;
  let adminS: SessionCredential;
  let aliceS: SessionCredential;
  let bobS: SessionCredential;
  let agentId: string;

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

  let caseSeq = 0;
  const caseBody = () => ({
    owner_kind: 'agent' as const,
    owner_id: agentId,
    name: `attr-case-${caseSeq++}`,
    input_diff: DIFF,
    input_meta: { title: 'Add rate limiting', number: 482 },
    expected_output: EXPECTED,
  });

  async function createAs(s: SessionCredential) {
    const res = await g.app.inject(
      asSession(s, { method: 'POST', url: '/eval-cases', payload: caseBody() }),
    );
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; created_by: unknown; creator_id?: unknown };
  }

  async function storedCase(id: string) {
    const [row] = await pg.handle.db.select().from(t.evalCases).where(eq(t.evalCases.id, id));
    return row;
  }

  beforeAll(async () => {
    pg = await startPg();
    g = await buildGoogleApp({
      pg,
      overrides: {
        git: new MockGitClient(),
        github: new MockGitHubClient(),
        llm: { openrouter: new MockLLMProvider('openrouter') },
      },
    });
    admin = await g.createUser({ role: 'admin', name: 'Ada Admin' });
    alice = await g.createUser({ role: 'member', name: 'Alice Member' });
    bob = await g.createUser({ role: 'member', name: 'Bob Member' });
    [adminS, aliceS, bobS] = await Promise.all([g.signIn(admin), g.signIn(alice), g.signIn(bob)]);
    const [agent] = await pg.handle.db
      .insert(t.agents)
      .values({
        workspaceId: g.workspaceId,
        name: 'Attribution Agent',
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash',
        systemPrompt: 'review the diff',
      })
      .returning();
    agentId = agent!.id;
  }, 120_000);

  afterAll(async () => {
    await g?.close();
    await pg?.stop();
  });

  it('POST /eval-cases records the creator; reads, lists and updates carry created_by (AC-47, AC-31)', async () => {
    const created = await createAs(aliceS);
    expect(created.created_by).toEqual({ user_id: alice.userId, name: 'Alice Member' });
    // The internal creator id never reaches the wire.
    expect(created).not.toHaveProperty('creator_id');
    expect((await storedCase(created.id))?.createdBy).toBe(alice.userId);

    // AC-31: Bob (another Member) sees Alice's case, attributed to Alice.
    const read = await g.app.inject(asSession(bobS, { method: 'GET', url: `/eval-cases/${created.id}` }));
    expect(read.statusCode).toBe(200);
    expect(read.json().created_by).toMatchObject({ user_id: alice.userId, name: 'Alice Member' });

    const list = await g.app.inject(
      asSession(bobS, { method: 'GET', url: `/agents/${agentId}/eval-cases` }),
    );
    expect(list.statusCode).toBe(200);
    const mine = (list.json() as Array<{ id: string; created_by: unknown }>).find(
      (c) => c.id === created.id,
    );
    expect(mine?.created_by).toMatchObject({ user_id: alice.userId });
  });

  it('PUT /eval-cases/:id — owner 200, other Member 403 forbidden_owner (no write), Admin 200 (AC-30)', async () => {
    const created = await createAs(aliceS);

    const denied = await g.app.inject(
      asSession(bobS, {
        method: 'PUT',
        url: `/eval-cases/${created.id}`,
        payload: { notes: 'bob was here' },
      }),
    );
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: 'forbidden_owner' } });
    expect((await storedCase(created.id))?.notes).toBeNull();

    const own = await g.app.inject(
      asSession(aliceS, { method: 'PUT', url: `/eval-cases/${created.id}`, payload: { notes: 'mine' } }),
    );
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ notes: 'mine', created_by: { user_id: alice.userId } });

    const byAdmin = await g.app.inject(
      asSession(adminS, { method: 'PUT', url: `/eval-cases/${created.id}`, payload: { notes: 'admin' } }),
    );
    expect(byAdmin.statusCode).toBe(200);
    // An edit never re-attributes the case: the creator stays Alice.
    expect(byAdmin.json().created_by).toMatchObject({ user_id: alice.userId });
    expect((await storedCase(created.id))?.createdBy).toBe(alice.userId);
  });

  it('DELETE /eval-cases/:id — other Member 403 (row kept), owner 200 (AC-30)', async () => {
    const created = await createAs(aliceS);

    const denied = await g.app.inject(
      asSession(bobS, { method: 'DELETE', url: `/eval-cases/${created.id}` }),
    );
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: 'forbidden_owner' } });
    expect(await storedCase(created.id)).toBeDefined();

    const own = await g.app.inject(
      asSession(aliceS, { method: 'DELETE', url: `/eval-cases/${created.id}` }),
    );
    expect(own.statusCode).toBe(200);
    expect(await storedCase(created.id)).toBeUndefined();
  });

  it('a legacy case (no recorded creator) is Admin-only: Member 403, Admin 200; DTO created_by null (AC-30, AC-48)', async () => {
    const [legacy] = await pg.handle.db
      .insert(t.evalCases)
      .values({
        workspaceId: g.workspaceId,
        ownerKind: 'agent',
        ownerId: agentId,
        name: `legacy-${caseSeq++}`,
        inputDiff: DIFF,
        inputMeta: {},
        expectedOutput: EXPECTED,
      })
      .returning();

    const read = await g.app.inject(asSession(aliceS, { method: 'GET', url: `/eval-cases/${legacy!.id}` }));
    expect(read.json().created_by).toBeNull();

    const memberPut = await g.app.inject(
      asSession(aliceS, { method: 'PUT', url: `/eval-cases/${legacy!.id}`, payload: { notes: 'x' } }),
    );
    expect(memberPut.statusCode).toBe(403);
    const memberDel = await g.app.inject(
      asSession(aliceS, { method: 'DELETE', url: `/eval-cases/${legacy!.id}` }),
    );
    expect(memberDel.statusCode).toBe(403);
    expect(await storedCase(legacy!.id)).toBeDefined();

    const adminPut = await g.app.inject(
      asSession(adminS, { method: 'PUT', url: `/eval-cases/${legacy!.id}`, payload: { notes: 'ok' } }),
    );
    expect(adminPut.statusCode).toBe(200);
    expect(adminPut.json().created_by).toBeNull();
    const adminDel = await g.app.inject(
      asSession(adminS, { method: 'DELETE', url: `/eval-cases/${legacy!.id}` }),
    );
    expect(adminDel.statusCode).toBe(200);
  });

  it("another workspace's case is 404 for a Member, never 403 (A01)", async () => {
    const [ws] = await pg.handle.db
      .insert(t.workspaces)
      .values({ name: `other-${Date.now()}` })
      .returning();
    const [foreign] = await pg.handle.db
      .insert(t.evalCases)
      .values({
        workspaceId: ws!.id,
        ownerKind: 'agent',
        ownerId: agentId,
        name: 'foreign',
        inputDiff: DIFF,
        expectedOutput: EXPECTED,
      })
      .returning();
    const res = await g.app.inject(
      asSession(bobS, { method: 'PUT', url: `/eval-cases/${foreign!.id}`, payload: { notes: 'x' } }),
    );
    expect(res.statusCode).toBe(404);
  });

  it('POST /findings/:id/eval-case records the clicking Member; a re-click keeps the original creator (AC-47)', async () => {
    const { db } = pg.handle;
    const [repo] = await db
      .insert(t.repos)
      .values({ workspaceId: g.workspaceId, owner: 'acme', name: 'eval-attr', fullName: 'acme/eval-attr' })
      .returning();
    const [pr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId: g.workspaceId,
        repoId: repo!.id,
        number: 77,
        title: 'Add rate limiting',
        author: 'marisa.koch',
        branch: 'feat/rl',
        base: 'main',
        headSha: 'a1b2c3d4',
      })
      .returning();
    await db.insert(t.prFiles).values({
      prId: pr!.id,
      path: 'src/pay.ts',
      additions: 1,
      patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,',
    });
    const [review] = await db
      .insert(t.reviews)
      .values({ workspaceId: g.workspaceId, prId: pr!.id, agentId, kind: 'review', score: 42 })
      .returning();
    const [finding] = await db
      .insert(t.findings)
      .values({
        reviewId: review!.id,
        file: 'src/pay.ts',
        startLine: 11,
        endLine: 11,
        severity: 'CRITICAL',
        category: 'security',
        title: 'Hardcoded Stripe secret key',
        rationale: 'A live Stripe key is committed in source.',
        confidence: 0.95,
        acceptedAt: new Date(),
      })
      .returning();

    const first = await g.app.inject(
      asSession(bobS, { method: 'POST', url: `/findings/${finding!.id}/eval-case` }),
    );
    expect(first.statusCode).toBe(201);
    expect(first.json().created_by).toEqual({ user_id: bob.userId, name: 'Bob Member' });

    const again = await g.app.inject(
      asSession(aliceS, { method: 'POST', url: `/findings/${finding!.id}/eval-case` }),
    );
    expect(again.statusCode).toBe(200);
    expect(again.json().created_by).toMatchObject({ user_id: bob.userId });
    expect((await storedCase(first.json().id))?.createdBy).toBe(bob.userId);
  });

  it('local mode attributes a new case to the system user (AC-49)', async () => {
    const local = await buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: pg.url,
      } as NodeJS.ProcessEnv),
      db: pg.handle.db,
      overrides: {
        git: new MockGitClient(),
        github: new MockGitHubClient(),
        llm: { openrouter: new MockLLMProvider('openrouter') },
      },
    });
    try {
      const res = await local.inject({ method: 'POST', url: '/eval-cases', payload: caseBody() });
      expect(res.statusCode).toBe(201);
      expect(res.json().created_by).toMatchObject({ user_id: g.systemUserId, is_system: true });
      expect((await storedCase(res.json().id))?.createdBy).toBe(g.systemUserId);
    } finally {
      await local.close();
    }
  });
});
