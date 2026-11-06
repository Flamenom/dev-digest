import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { waitForPrRuns } from './helpers/runs.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockLLMProvider, MockEmbedder, MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';
import { NO_ENABLED_AGENTS } from '../src/modules/reviews/constants.js';
import * as t from '../src/db/schema.js';
import { eq, sql } from 'drizzle-orm';
import type { Review } from '@devdigest/shared';

/**
 * AC-61: "run all enabled agents" with no enabled agent in the workspace →
 * 409 `no_enabled_agents`, and no `agent_runs` row is created. A single-agent
 * run (even of a disabled agent) keeps its existing 2xx behaviour.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

const DIFF = `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -10,3 +10,4 @@
   port: 3000,
+  stripeKey: "sk_live_xxx",
   redisUrl: x,`;

const REVIEW_FIXTURE: Review = {
  verdict: 'comment',
  summary: 'Looks fine.',
  score: 90,
  findings: [],
};

d('AC-61 run-all with no enabled agent (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let prId: string;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
    // Start from zero agents in this file's own database.
    await pg.handle.db.delete(t.agents).where(eq(t.agents.workspaceId, workspaceId));

    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name: 'no-agents-api', fullName: 'acme/no-agents-api' })
      .returning();
    const [pr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 7,
        title: 'Tweak config',
        author: 'marisa.koch',
        branch: 'feat/cfg',
        base: 'main',
        headSha: 'a1b2c3d4',
        additions: 1,
        deletions: 0,
        filesCount: 1,
        status: 'needs_review',
        body: 'Tweak config.',
      })
      .returning();
    await pg.handle.db.insert(t.prFiles).values({
      prId: pr!.id,
      path: 'src/config.ts',
      additions: 1,
      deletions: 0,
      patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,',
    });
    prId = pr!.id;
  });
  afterAll(async () => {
    await pg?.stop();
  });

  // Hermetic: git host and LLM providers are mocked (no network, no real keys).
  function app() {
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        git: new MockGitClient({ diff: DIFF }),
        github: new MockGitHubClient(),
        llm: {
          openrouter: new MockLLMProvider('openrouter', { structured: REVIEW_FIXTURE }),
          openai: new MockLLMProvider('openai', { structured: REVIEW_FIXTURE }),
        },
      },
    });
  }

  async function runCount(): Promise<number> {
    const [row] = await pg.handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(t.agentRuns);
    return row!.n;
  }

  it('the error code constant is the wire value', () => {
    expect(NO_ENABLED_AGENTS).toBe('no_enabled_agents');
  });

  it('zero agents → 409 no_enabled_agents, no run created', async () => {
    const a = await app();
    const before = await runCount();
    const res = await a.inject({ method: 'POST', url: `/pulls/${prId}/review`, payload: { all: true } });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe('no_enabled_agents');
    expect(body.error.message).toMatch(/create or enable an agent/i);
    expect(await runCount()).toBe(before);
    await a.close();
  });

  it('one disabled agent → still 409; a direct single-agent run of it → 2xx; enabling it → run-all 2xx', async () => {
    const a = await app();
    const created = await a.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'Solo', provider: 'openai', model: 'gpt-4.1', system_prompt: 's' },
    });
    expect(created.statusCode).toBe(201);
    const agentId = created.json().id as string;
    await pg.handle.db.update(t.agents).set({ enabled: false }).where(eq(t.agents.id, agentId));

    const before = await runCount();
    const refused = await a.inject({ method: 'POST', url: `/pulls/${prId}/review`, payload: { all: true } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('no_enabled_agents');
    expect(await runCount()).toBe(before);

    // Existing behaviour: an explicit agentId runs even when the agent is disabled.
    const single = await a.inject({ method: 'POST', url: `/pulls/${prId}/review`, payload: { agentId } });
    expect(single.statusCode).toBe(200);
    expect(single.json().runs).toHaveLength(1);
    await waitForPrRuns(pg.handle.db, prId, { expected: 1 });

    await pg.handle.db.update(t.agents).set({ enabled: true }).where(eq(t.agents.id, agentId));
    const ok = await a.inject({ method: 'POST', url: `/pulls/${prId}/review`, payload: { all: true } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().runs).toHaveLength(1);
    // Drain the fire-and-forget run before the DB fixture stops.
    await waitForPrRuns(pg.handle.db, prId, { expected: 2 });
    await a.close();
  });
});
