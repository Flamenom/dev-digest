/**
 * L04 — Blast Radius integration (Testcontainers pg; plan T6).
 *
 * GET /pulls/:id/blast end-to-end over a REAL persistent index: seeded
 * repo_index_state / symbols / references / file_rank / file_facts /
 * file_edges rows, asserting the response round-trips the BlastResponse
 * contract with per-symbol callers, facts attribution, the depth-1/depth-2
 * endpoint union, and the prior-PRs SQL (overlap aggregation, current-PR and
 * cross-repo exclusion, updatedAt-desc ordering, cap 5). Plus the
 * `getReverseDependents` BFS over the real file_edges SQL, and the 404 path.
 *
 * Gated on Docker; unique repo fullNames — seed already owns
 * acme/payments-api (repos_ws_fullname_uq, see server/INSIGHTS.md).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { BlastResponse } from '@devdigest/shared';
import { RepoIntelService } from '../src/modules/repo-intel/service.js';
import { INDEXER_VERSION } from '../src/modules/repo-intel/constants.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () =>
  loadConfig({ ...process.env, NODE_ENV: 'test', REPO_INTEL_ENABLED: 'true' } as NodeJS.ProcessEnv);

d('blast route (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let repoId: string;
  let prId: string;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const db = pg.handle.db;
    const [ws] = await db.select().from(t.workspaces);
    workspaceId = ws!.id;
    app = await buildApp({ config: config(), db });

    // ---- Main fixture: an indexed repo with one PR. -------------------------
    const [repo] = await db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name: 'blast-fixture', fullName: 'acme/blast-fixture' })
      .returning();
    repoId = repo!.id;

    const [pr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId,
        number: 7,
        title: 'Rework money rounding',
        author: 'marisa.koch',
        branch: 'feat/rounding',
        base: 'main',
        headSha: 'deadbeef',
        status: 'open',
      })
      .returning();
    prId = pr!.id;
    await db.insert(t.prFiles).values([
      { prId, path: 'src/money.ts', additions: 20, deletions: 4 },
      { prId, path: 'README.md', additions: 2, deletions: 0 },
    ]);

    // Persistent index: full status → the service may serve blast data.
    await db.insert(t.repoIndexState).values({
      repoId,
      lastIndexedSha: 'deadbeef',
      indexerVersion: INDEXER_VERSION,
      status: 'full',
      filesIndexed: 10,
      filesSkipped: 0,
    });

    await db.insert(t.symbols).values([
      // Changed symbol + its qualified dual-emit (must be skipped by name '.').
      { repoId, path: 'src/money.ts', name: 'roundCents', kind: 'function', line: 3, endLine: 9, exported: true },
      { repoId, path: 'src/money.ts', name: 'Money.roundCents', kind: 'method', line: 3, endLine: 9, exported: true },
      // Enclosing symbols in the caller files.
      { repoId, path: 'src/routes/checkout.ts', name: 'checkoutHandler', kind: 'function', line: 10, endLine: 60, exported: true },
      { repoId, path: 'src/jobs/nightly.ts', name: 'nightlyJob', kind: 'function', line: 5, endLine: 40, exported: false },
    ]);

    await db.insert(t.references).values([
      { repoId, fromPath: 'src/routes/checkout.ts', toSymbol: 'roundCents', line: 42, declFile: 'src/money.ts' },
      { repoId, fromPath: 'src/jobs/nightly.ts', toSymbol: 'roundCents', line: 12, declFile: 'src/money.ts' },
      // Unresolved (NULL decl_file) → precision rule: NOT asserted as a caller.
      { repoId, fromPath: 'src/other.ts', toSymbol: 'roundCents', line: 5, declFile: null },
    ]);

    await db.insert(t.fileRank).values([
      { repoId, filePath: 'src/routes/checkout.ts', pagerank: 0.9, hotness: 0, rank: 0.9, percentile: 90 },
      { repoId, filePath: 'src/jobs/nightly.ts', pagerank: 0.4, hotness: 0, rank: 0.4, percentile: 40 },
    ]);

    await db.insert(t.fileFacts).values([
      { repoId, filePath: 'src/routes/checkout.ts', endpoints: ['POST /checkout'], crons: [] },
      { repoId, filePath: 'src/jobs/nightly.ts', endpoints: [], crons: ['0 3 * * *'] },
      { repoId, filePath: 'src/app.ts', endpoints: ['GET /health'], crons: [] },
    ]);

    // Reverse-import graph: depth 1 = checkout + nightly, depth 2 = app.ts.
    await db.insert(t.fileEdges).values([
      { repoId, fromFile: 'src/routes/checkout.ts', toFile: 'src/money.ts' },
      { repoId, fromFile: 'src/jobs/nightly.ts', toFile: 'src/money.ts' },
      { repoId, fromFile: 'src/app.ts', toFile: 'src/routes/checkout.ts' },
    ]);

    // ---- Prior PRs in the SAME repo. ---------------------------------------
    const priorBase = {
      workspaceId,
      repoId,
      author: 'dev',
      branch: 'x',
      base: 'main',
      headSha: 'aaa',
    };
    const [pr3] = await db
      .insert(t.pullRequests)
      .values({ ...priorBase, number: 3, title: 'Refactor rounding', status: 'merged', updatedAt: new Date('2026-08-01T00:00:00Z') })
      .returning();
    const [pr4] = await db
      .insert(t.pullRequests)
      .values({ ...priorBase, number: 4, title: 'Docs pass', status: 'open', updatedAt: new Date('2026-08-10T00:00:00Z') })
      .returning();
    const [pr5] = await db
      .insert(t.pullRequests)
      .values({ ...priorBase, number: 5, title: 'Unrelated', status: 'open', updatedAt: new Date('2026-08-12T00:00:00Z') })
      .returning();
    await db.insert(t.prFiles).values([
      { prId: pr3!.id, path: 'src/money.ts' },
      { prId: pr3!.id, path: 'src/unrelated.ts' },
      { prId: pr4!.id, path: 'README.md' },
      { prId: pr5!.id, path: 'src/unrelated.ts' }, // no overlap → excluded
    ]);

    // ---- A DIFFERENT repo touching the same path → must never leak in. -----
    const [other] = await db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name: 'blast-other', fullName: 'acme/blast-other' })
      .returning();
    const [otherPr] = await db
      .insert(t.pullRequests)
      .values({ ...priorBase, repoId: other!.id, number: 9, title: 'Other repo', status: 'open', updatedAt: new Date('2026-08-15T00:00:00Z') })
      .returning();
    await db.insert(t.prFiles).values([{ prId: otherPr!.id, path: 'src/money.ts' }]);
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  it('serves the full blast radius from the persistent index (contract round-trip)', async () => {
    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/blast` });
    expect(res.statusCode).toBe(200);
    const body = BlastResponse.parse(res.json());

    expect(body.status).toBe('ok');
    expect(body.reason).toBeNull();
    expect(body.summary).toBeNull();

    // One changed symbol — the qualified 'Money.roundCents' dual-emit skipped.
    expect(body.symbols).toHaveLength(1);
    const sym = body.symbols[0]!;
    expect(sym.symbol).toEqual({ name: 'roundCents', file: 'src/money.ts', kind: 'function' });

    // Resolved callers only (the NULL-decl_file ref is absent), rank desc,
    // enclosing symbol resolved from the caller files' own symbol rows.
    expect(sym.callers).toEqual([
      { file: 'src/routes/checkout.ts', line: 42, symbol: 'checkoutHandler', rank: 0.9 },
      { file: 'src/jobs/nightly.ts', line: 12, symbol: 'nightlyJob', rank: 0.4 },
    ]);

    // Facts attributed from BOTH caller files.
    expect(sym.endpoints_affected).toEqual(['POST /checkout']);
    expect(sym.crons_affected).toEqual(['0 3 * * *']);

    // Endpoint union: depth-1 (caller file facts) + depth-2 (reverse imports),
    // deduped — checkout's endpoint appears once, at depth 1.
    expect(body.endpoints.toSorted((a, b) => a.endpoint.localeCompare(b.endpoint))).toEqual([
      { endpoint: 'GET /health', file: 'src/app.ts', depth: 2 },
      { endpoint: 'POST /checkout', file: 'src/routes/checkout.ts', depth: 1 },
    ]);

    expect(body.counts).toEqual({ symbols: 1, callers: 2, endpoints: 2, crons: 1 });

    // Prior PRs: overlap with THIS repo only, newest updatedAt first, and the
    // current PR + the no-overlap PR + the other-repo PR are all excluded.
    expect(body.prior_prs).toEqual([
      { number: 4, title: 'Docs pass', author: 'dev', status: 'open', files_overlap: ['README.md'] },
      { number: 3, title: 'Refactor rounding', author: 'dev', status: 'merged', files_overlap: ['src/money.ts'] },
    ]);
  });

  it('getReverseDependents walks the real file_edges SQL: depth 1+2, changed file excluded', async () => {
    const svc = new RepoIntelService({
      config: { repoIntelEnabled: true },
      db: pg.handle.db,
    } as never);

    const rows = await svc.getReverseDependents(repoId, ['src/money.ts']);
    expect(rows.toSorted((a, b) => a.file.localeCompare(b.file))).toEqual([
      { file: 'src/app.ts', depth: 2, endpoints: ['GET /health'], crons: [] },
      { file: 'src/jobs/nightly.ts', depth: 1, endpoints: [], crons: ['0 3 * * *'] },
      { file: 'src/routes/checkout.ts', depth: 1, endpoints: ['POST /checkout'], crons: [] },
    ]);
    expect(rows.map((r) => r.file)).not.toContain('src/money.ts');
  });

  it('caps prior PRs at 5, newest-first (status empty still carries prior PRs)', async () => {
    const db = pg.handle.db;
    // Fresh indexed repo whose PR has NO symbols → status 'empty', which is the
    // one non-ok path that still returns prior_prs.
    const [repo] = await db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name: 'blast-priors', fullName: 'acme/blast-priors' })
      .returning();
    await db.insert(t.repoIndexState).values({
      repoId: repo!.id,
      lastIndexedSha: 'bbb',
      indexerVersion: INDEXER_VERSION,
      status: 'full',
    });

    const base = {
      workspaceId,
      repoId: repo!.id,
      author: 'dev',
      branch: 'x',
      base: 'main',
      headSha: 'bbb',
    };
    const [current] = await db
      .insert(t.pullRequests)
      .values({ ...base, number: 100, title: 'Current', status: 'open' })
      .returning();
    await db.insert(t.prFiles).values([{ prId: current!.id, path: 'lib/shared.ts' }]);

    for (let n = 1; n <= 7; n += 1) {
      const [prior] = await db
        .insert(t.pullRequests)
        .values({
          ...base,
          number: n,
          title: `Prior ${n}`,
          status: 'merged',
          updatedAt: new Date(`2026-08-0${n}T00:00:00Z`),
        })
        .returning();
      await db.insert(t.prFiles).values([{ prId: prior!.id, path: 'lib/shared.ts' }]);
    }

    const res = await app.inject({ method: 'GET', url: `/pulls/${current!.id}/blast` });
    expect(res.statusCode).toBe(200);
    const body = BlastResponse.parse(res.json());

    expect(body.status).toBe('empty');
    expect(body.reason).toMatch(/no symbols/i);
    // Cap 5, ordered by updatedAt desc; #100 (current) excluded.
    expect(body.prior_prs.map((p) => p.number)).toEqual([7, 6, 5, 4, 3]);
    expect(body.prior_prs[0]!.files_overlap).toEqual(['lib/shared.ts']);
  });

  it('unknown pr id → 404', async () => {
    const res = await app.inject({ method: 'GET', url: `/pulls/${randomUUID()}/blast` });
    expect(res.statusCode).toBe(404);
  });
});
