/**
 * Smart Diff integration — GET /pulls/:id/smart-diff over real Postgres
 * (spec 05 §9). Persists pr_files + reviews from TWO agents (including an
 * older superseded review and a dismissed finding), then asserts the response
 * round-trips through the frozen SmartDiffResponse contract and that
 * finding_lines reflect ONLY the latest review per agent, non-dismissed.
 * Gated on Docker like the other integration tests; unique repo fullName
 * (seed already owns acme/payments-api — see server/INSIGHTS.md).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { SmartDiffResponse } from '@devdigest/shared';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

/** Insert one review (explicit createdAt drives the newest-first ordering). */
async function insertReview(
  db: PgFixture['handle']['db'],
  values: {
    workspaceId: string;
    prId: string;
    agentId: string | null;
    kind: 'summary' | 'review';
    createdAt: Date;
  },
) {
  const [review] = await db
    .insert(t.reviews)
    .values({ ...values, verdict: 'approve', summary: 's', score: 80, model: 'm' })
    .returning();
  return review!;
}

/** Insert one finding with all NOT NULL columns filled. */
async function insertFinding(
  db: PgFixture['handle']['db'],
  values: { reviewId: string; file: string; startLine: number; endLine: number; dismissedAt?: Date },
) {
  await db.insert(t.findings).values({
    severity: 'WARNING',
    category: 'correctness',
    title: 'finding',
    rationale: 'because',
    confidence: 0.9,
    dismissedAt: values.dismissedAt ?? null,
    ...values,
  });
}

d('smart-diff route (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
    app = await buildApp({ config: config(), db: pg.handle.db });
  });
  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  it('returns the grouped SmartDiff with latest-per-agent finding lines, dismissed excluded', async () => {
    const db = pg.handle.db;

    // Unique fullName — seed already owns acme/payments-api (repos_ws_fullname_uq).
    const [repo] = await db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name: 'smart-diff-fixture', fullName: 'acme/smart-diff-fixture' })
      .returning();
    const [pr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 42,
        title: 'Charge retries',
        author: 'marisa.koch',
        branch: 'feat/charge-retries',
        base: 'main',
        headSha: 'cafebabe',
        additions: 424,
        deletions: 281,
        filesCount: 3,
        status: 'open',
      })
      .returning();

    // A mix of core / wiring / boilerplate paths.
    await db.insert(t.prFiles).values([
      { prId: pr!.id, path: 'src/payments/charge.ts', additions: 120, deletions: 30 },
      { prId: pr!.id, path: 'package.json', additions: 4, deletions: 1 },
      { prId: pr!.id, path: 'pnpm-lock.yaml', additions: 300, deletions: 250 },
    ]);

    const agentA = randomUUID();
    const agentB = randomUUID();

    // Agent A, SUPERSEDED older review — its findings must NOT surface.
    const staleA = await insertReview(db, {
      workspaceId,
      prId: pr!.id,
      agentId: agentA,
      kind: 'review',
      createdAt: new Date('2026-08-01T00:00:00Z'),
    });
    await insertFinding(db, { reviewId: staleA.id, file: 'src/payments/charge.ts', startLine: 100, endLine: 101 });

    // Agent A, latest review — one live finding + one DISMISSED finding.
    const latestA = await insertReview(db, {
      workspaceId,
      prId: pr!.id,
      agentId: agentA,
      kind: 'review',
      createdAt: new Date('2026-08-02T00:00:00Z'),
    });
    await insertFinding(db, { reviewId: latestA.id, file: 'src/payments/charge.ts', startLine: 10, endLine: 12 });
    await insertFinding(db, {
      reviewId: latestA.id,
      file: 'src/payments/charge.ts',
      startLine: 50,
      endLine: 50,
      dismissedAt: new Date('2026-08-02T12:00:00Z'),
    });

    // Agent B — a second agent's latest review; its lines UNION with A's.
    const latestB = await insertReview(db, {
      workspaceId,
      prId: pr!.id,
      agentId: agentB,
      kind: 'review',
      createdAt: new Date('2026-08-02T01:00:00Z'),
    });
    await insertFinding(db, { reviewId: latestB.id, file: 'src/payments/charge.ts', startLine: 20, endLine: 20 });
    await insertFinding(db, { reviewId: latestB.id, file: 'package.json', startLine: 5, endLine: 5 });

    // A newer kind='summary' row — must be ignored (and must not consume agent B's slot).
    const summary = await insertReview(db, {
      workspaceId,
      prId: pr!.id,
      agentId: agentB,
      kind: 'summary',
      createdAt: new Date('2026-08-03T00:00:00Z'),
    });
    await insertFinding(db, { reviewId: summary.id, file: 'src/payments/charge.ts', startLine: 999, endLine: 999 });

    const res = await app.inject({ method: 'GET', url: `/pulls/${pr!.id}/smart-diff` });
    expect(res.statusCode).toBe(200);

    // Frozen contract round-trip.
    const body = SmartDiffResponse.parse(res.json());

    expect(body.groups.map((g) => g.role)).toEqual(['core', 'wiring', 'boilerplate']);
    const [core, wiring, boilerplate] = body.groups;

    // Core: latest-per-agent union (A: 10–12, B: 20); stale 100–101, dismissed 50
    // and the summary row's 999 are all excluded.
    expect(core!.files).toEqual([
      {
        path: 'src/payments/charge.ts',
        pseudocode_summary: null,
        additions: 120,
        deletions: 30,
        finding_lines: [10, 11, 12, 20],
      },
    ]);
    expect(wiring!.files).toEqual([
      { path: 'package.json', pseudocode_summary: null, additions: 4, deletions: 1, finding_lines: [5] },
    ]);
    expect(boilerplate!.files).toEqual([
      { path: 'pnpm-lock.yaml', pseudocode_summary: null, additions: 300, deletions: 250, finding_lines: [] },
    ]);

    // 705 changed lines — under the 1000 threshold.
    expect(body.split_suggestion).toEqual({ too_big: false, total_lines: 705, proposed_splits: [] });
  });

  it('unknown pr id → 404', async () => {
    const res = await app.inject({ method: 'GET', url: `/pulls/${randomUUID()}/smart-diff` });
    expect(res.statusCode).toBe(404);
  });
});
