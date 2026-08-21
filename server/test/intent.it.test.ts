import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitHubClient, MockGitClient, MockLLMProvider } from '../src/adapters/mocks.js';
import { IntentDetail } from '@devdigest/shared';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  console.warn('[intent] Docker not available — skipping integration tests.');
}

/**
 * L03 Intent Layer against a real Postgres (migration 0014 applied): classify
 * persists an IntentDetail row, GET round-trips it, re-classify UPSERTS (still
 * one pr_intent row), and a head_sha change flips `stale: true` until the next
 * classification. Uses a UNIQUE repo fullName (seed owns `acme/payments-api` —
 * see server/INSIGHTS.md `repos_ws_fullname_uq`).
 */
d('intent module (integration)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let repoId: string;
  let prId: string;

  const CLASSIFICATION_FIXTURE = {
    summary: 'Introduce per-IP rate limiting on the public API endpoints.',
    in_scope: ['Token-bucket middleware'],
    out_of_scope: ['Auth changes'],
    risk_areas: ['New dependency: ioredis'],
  };

  beforeAll(async () => {
    pg = await startPg();
    const seeded = await seed(pg.handle.db);
    workspaceId = seeded.workspaceId;
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name: 'intent-lab', fullName: 'acme/intent-lab' })
      .returning();
    repoId = repo!.id;
    const [pull] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId,
        number: 900,
        title: 'Add rate limiting to public API endpoints',
        author: 'marisa.koch',
        branch: 'feat/rate-limit-public',
        base: 'main',
        headSha: 'sha-1',
        body: 'Adds a per-IP limiter to the public API. Fixes #471.',
      })
      .returning();
    prId = pull!.id;
    await pg.handle.db.insert(t.prFiles).values({
      prId,
      path: 'src/middleware/ratelimit.ts',
      additions: 40,
      deletions: 0,
      patch: '@@ -0,0 +1,40 @@\n+export function rateLimit() {}',
    });
  });
  afterAll(async () => {
    await pg?.stop();
  });

  function makeApp() {
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    return buildApp({
      config,
      db: pg.handle.db,
      overrides: {
        github: new MockGitHubClient(),
        git: new MockGitClient(),
        // review_intent's registry default resolves to the openrouter provider.
        llm: {
          openrouter: new MockLLMProvider('openai', {
            structuredBySchema: { IntentClassification: CLASSIFICATION_FIXTURE },
          }),
        },
      },
    });
  }

  it('GET before any classification → 404', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/intent` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('POST classifies + persists; GET round-trips the same IntentDetail', async () => {
    const app = await makeApp();

    const post = await app.inject({ method: 'POST', url: `/pulls/${prId}/intent` });
    expect(post.statusCode).toBe(200);
    const created = IntentDetail.parse(post.json());
    expect(created).toMatchObject({
      pr_id: prId,
      intent: CLASSIFICATION_FIXTURE.summary,
      in_scope: CLASSIFICATION_FIXTURE.in_scope,
      out_of_scope: CLASSIFICATION_FIXTURE.out_of_scope,
      risk_areas: CLASSIFICATION_FIXTURE.risk_areas,
      confidence: 'high', // PR body + linked issue both fetched, nothing unavailable
      head_sha: 'sha-1',
      stale: false,
    });
    expect(created.sources).toContainEqual({
      kind: 'pr_description',
      ref: 'PR description',
      status: 'fetched',
    });
    expect(created.sources).toContainEqual(
      expect.objectContaining({ kind: 'linked_issue', ref: '#471', status: 'fetched' }),
    );

    const get = await app.inject({ method: 'GET', url: `/pulls/${prId}/intent` });
    expect(get.statusCode).toBe(200);
    expect(IntentDetail.parse(get.json())).toEqual(created);
    await app.close();
  });

  it('re-classify UPSERTS — still exactly one pr_intent row', async () => {
    const app = await makeApp();

    const again = await app.inject({ method: 'POST', url: `/pulls/${prId}/intent` });
    expect(again.statusCode).toBe(200);

    const rows = await pg.handle.db.select().from(t.prIntent).where(eq(t.prIntent.prId, prId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      intent: CLASSIFICATION_FIXTURE.summary,
      confidence: 'high',
      headSha: 'sha-1',
    });
    await app.close();
  });

  it('head_sha change → stale: true; re-classify refreshes to the new head', async () => {
    const app = await makeApp();

    await pg.handle.db
      .update(t.pullRequests)
      .set({ headSha: 'sha-2' })
      .where(eq(t.pullRequests.id, prId));

    const staleGet = await app.inject({ method: 'GET', url: `/pulls/${prId}/intent` });
    expect(staleGet.statusCode).toBe(200);
    expect(staleGet.json()).toMatchObject({ head_sha: 'sha-1', stale: true });

    const repost = await app.inject({ method: 'POST', url: `/pulls/${prId}/intent` });
    expect(repost.statusCode).toBe(200);
    expect(repost.json()).toMatchObject({ head_sha: 'sha-2', stale: false });

    const rows = await pg.handle.db.select().from(t.prIntent).where(eq(t.prIntent.prId, prId));
    expect(rows).toHaveLength(1); // still upserting, never duplicating
    await app.close();
  });

  it('404 for a PR outside the workspace; 422 for a non-uuid id', async () => {
    const app = await makeApp();
    const missing = await app.inject({
      method: 'GET',
      url: '/pulls/00000000-0000-0000-0000-000000000000/intent',
    });
    expect(missing.statusCode).toBe(404);
    const invalid = await app.inject({ method: 'POST', url: '/pulls/not-a-uuid/intent' });
    expect(invalid.statusCode).toBe(422);
    await app.close();
  });
});
