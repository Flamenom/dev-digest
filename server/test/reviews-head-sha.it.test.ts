import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { HostRepoRef, Review, UnifiedDiff } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { waitForPrRuns } from './helpers/runs.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockLLMProvider, MockEmbedder, MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';

/**
 * AC-1 — a review records the head SHA of the diff it actually reviewed:
 * local diff → the PR head it diffed; pr_files fallback → `detail_head_sha`;
 * rows written without the column → `head_sha: null`.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

const PATCH = '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,';
const DIFF = `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
${PATCH}`;

const REVIEW_FIXTURE: Review = {
  verdict: 'request_changes',
  summary: 'Hardcoded secret.',
  score: 40,
  findings: [
    {
      id: 'f-1',
      severity: 'CRITICAL',
      category: 'security',
      title: 'Hardcoded key',
      file: 'src/config.ts',
      start_line: 11,
      end_line: 11,
      rationale: 'A live key is committed.',
      confidence: 0.9,
      kind: 'finding',
    },
  ],
};

/** A git client whose local diff always fails → the executor uses pr_files. */
class FailingDiffGit extends MockGitClient {
  override async diff(_repo?: HostRepoRef, _base?: string, _head?: string): Promise<UnifiedDiff> {
    throw new Error('fatal: no merge base');
  }
}

let seq = 0;

d('reviews.head_sha (AC-1, Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
  });
  afterAll(async () => {
    await pg?.stop();
  });

  async function setupPr(opts: { headSha: string; detailHeadSha: string | null }) {
    const db = pg.handle.db;
    const name = `head-sha-api-${seq++}`;
    const [repo] = await db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}` })
      .returning();
    const [pr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 900 + seq,
        title: 'Head sha',
        author: 'dev',
        branch: 'feat/x',
        base: 'main',
        headSha: opts.headSha,
        detailHeadSha: opts.detailHeadSha,
        additions: 1,
        deletions: 0,
        filesCount: 1,
        status: 'needs_review',
        body: 'No linked issues.',
      })
      .returning();
    await db.insert(t.prFiles).values({
      prId: pr!.id,
      path: 'src/config.ts',
      additions: 1,
      deletions: 0,
      patch: PATCH,
    });
    return pr!;
  }

  function appWith(git: MockGitClient) {
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        git,
        github: new MockGitHubClient(),
        llm: {
          openrouter: new MockLLMProvider('openrouter', { structured: REVIEW_FIXTURE }),
          openai: new MockLLMProvider('openai', { structured: REVIEW_FIXTURE }),
        },
      },
    });
  }

  async function runOne(app: Awaited<ReturnType<typeof appWith>>, prId: string) {
    const agent = (
      await app.inject({
        method: 'POST',
        url: '/agents',
        payload: { name: `HeadSha ${seq}-${Date.now()}`, provider: 'openai', model: 'gpt-4.1', system_prompt: 's' },
      })
    ).json();
    const res = await app.inject({ method: 'POST', url: `/pulls/${prId}/review`, payload: { agentId: agent.id } });
    expect(res.statusCode).toBe(200);
    await waitForPrRuns(pg.handle.db, prId, { expected: 1 });
    return (await app.inject({ method: 'GET', url: `/pulls/${prId}/reviews` })).json();
  }

  it('local diff → records the PR head that was diffed', async () => {
    const app = await appWith(new MockGitClient({ diff: DIFF }));
    const pr = await setupPr({ headSha: 'abc', detailHeadSha: 'ignored-detail' });

    const reviews = await runOne(app, pr.id);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].head_sha).toBe('abc');

    const [row] = await pg.handle.db.select().from(t.reviews).where(eq(t.reviews.prId, pr.id));
    expect(row!.headSha).toBe('abc');
    await app.close();
  });

  it('fallback diff (local git diff fails) → records detail_head_sha', async () => {
    const app = await appWith(new FailingDiffGit());
    const pr = await setupPr({ headSha: 'list-head', detailHeadSha: 'detail-head' });

    const reviews = await runOne(app, pr.id);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].head_sha).toBe('detail-head');
    await app.close();
  });

  it('a row inserted without the column → head_sha: null', async () => {
    const app = await appWith(new MockGitClient({ diff: DIFF }));
    const pr = await setupPr({ headSha: 'old', detailHeadSha: null });
    await pg.handle.db.insert(t.reviews).values({
      workspaceId,
      prId: pr.id,
      kind: 'review',
      verdict: 'comment',
      summary: 'legacy',
      score: 90,
      model: 'm',
    });

    const reviews = (await app.inject({ method: 'GET', url: `/pulls/${pr.id}/reviews` })).json();
    expect(reviews).toHaveLength(1);
    expect(reviews[0].head_sha).toBeNull();
    await app.close();
  });
});
