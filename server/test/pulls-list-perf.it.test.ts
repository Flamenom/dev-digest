import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrMeta } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient, MockSecretsProvider } from '../src/adapters/mocks.js';

/**
 * T9 NFR — the PR-list read hits the DB only: with 1 000 persisted PRs (a slice
 * of them reviewed) and a host sync IN FLIGHT, 20 reads have p95 ≤ 300 ms.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const PR_COUNT = 1_000;
const REVIEWED = 200;
const READS = 20;
const P95_BUDGET_MS = 300;

/** A host whose list call never answers — the sync stays running for the whole test. */
class HangingGitHub extends MockGitHubClient {
  override listPullRequests(): Promise<PrMeta[]> {
    return new Promise<PrMeta[]>(() => undefined);
  }
}

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

d('PR list read performance (1 000 PRs, sync running)', () => {
  let pg: PgFixture;
  let app: FastifyInstance;
  let repoId: string;

  beforeAll(async () => {
    pg = await startPg();
    const { db } = pg.handle;
    const { workspaceId } = await seed(db);
    const [repo] = await db
      .insert(t.repos)
      .values({ workspaceId, owner: 'perf', name: 'big', fullName: 'perf/big' })
      .returning();
    repoId = repo!.id;

    const prs = await db
      .insert(t.pullRequests)
      .values(
        Array.from({ length: PR_COUNT }, (_, i) => ({
          workspaceId,
          repoId,
          number: i + 1,
          title: `PR ${i + 1}`,
          author: 'dev',
          branch: `feat/${i + 1}`,
          base: 'main',
          headSha: `sha-${i + 1}`,
          additions: 10,
          deletions: 2,
          filesCount: 3,
          status: 'open',
          openedAt: new Date(Date.UTC(2026, 8, 1) + i * 60_000),
          updatedAt: new Date(Date.UTC(2026, 8, 2) + i * 60_000),
        })),
      )
      .returning({ id: t.pullRequests.id });

    const reviews = await db
      .insert(t.reviews)
      .values(
        prs.slice(0, REVIEWED).map((pr, i) => ({
          workspaceId,
          prId: pr.id,
          kind: 'review' as const,
          verdict: 'comment',
          score: 50 + (i % 50),
          model: 'perf',
        })),
      )
      .returning({ id: t.reviews.id });
    await db.insert(t.findings).values(
      reviews.flatMap((rv) =>
        (['CRITICAL', 'WARNING', 'SUGGESTION'] as const).map((severity, j) => ({
          reviewId: rv.id,
          file: 'src/a.ts',
          startLine: j + 1,
          endLine: j + 1,
          severity,
          category: 'perf',
          title: `Finding ${j}`,
          rationale: 'r',
          confidence: 0.9,
        })),
      ),
    );

    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    app = await buildApp({
      config,
      db,
      overrides: {
        git: new MockGitClient(),
        github: new HangingGitHub(),
        secrets: new MockSecretsProvider({}),
      },
    });
  });
  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  it(`20 reads of /pulls/page and /pulls: p95 ≤ ${P95_BUDGET_MS} ms while a sync runs`, async () => {
    // Warm-up read also starts the (never-finishing) sync.
    const warm = await app.inject({ method: 'GET', url: `/repos/${repoId}/pulls/page` });
    expect(warm.statusCode).toBe(200);
    expect(warm.json().pulls).toHaveLength(PR_COUNT);
    expect(app.container.prSync.isRunning(repoId)).toBe(true);

    for (const url of [`/repos/${repoId}/pulls/page`, `/repos/${repoId}/pulls`]) {
      const samples: number[] = [];
      for (let i = 0; i < READS; i++) {
        const started = performance.now();
        const res = await app.inject({ method: 'GET', url });
        samples.push(performance.now() - started);
        expect(res.statusCode).toBe(200);
      }
      const last = await app.inject({ method: 'GET', url });
      const body = last.json();
      const pulls = Array.isArray(body) ? body : body.pulls;
      expect(pulls).toHaveLength(PR_COUNT);
      expect(pulls.filter((p: { score: number | null }) => p.score != null)).toHaveLength(REVIEWED);
      if (!Array.isArray(body)) expect(body.sync.state).toBe('running');
      console.info(`[pulls-list-perf] ${url} p95=${p95(samples).toFixed(1)}ms`);
      expect(p95(samples), `${url} p95 (samples: ${samples.map((s) => s.toFixed(1)).join(', ')})`).toBeLessThanOrEqual(
        P95_BUDGET_MS,
      );
    }
    expect(app.container.prSync.isRunning(repoId)).toBe(true);
  });
});
