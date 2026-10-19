import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { HostRepoRef, PrDetailHost, PrMetaHost, PullRequestHost } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { PullRequestRepository } from '../src/modules/pulls/repository.js';
import { SyncStatusRepository } from '../src/modules/pulls/repository.js';
import { PrListSyncService, type SyncRepo } from '../src/modules/pulls/sync-service.js';
import { PrSyncCoordinator } from '../src/modules/pulls/sync-coordinator.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

function mr(number: number, over: Partial<PrMetaHost> = {}): PrMetaHost {
  return {
    number,
    title: `MR ${number}`,
    author: 'dev',
    branch: `feat/${number}`,
    base: 'main',
    head_sha: `sha-${number}-a`,
    additions: 5,
    deletions: 2,
    files_count: 1,
    status: 'open',
    opened_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-02T00:00:00.000Z',
    ...over,
  };
}

d('PR sync repositories (Postgres)', () => {
  let pg: PgFixture;
  let prs: PullRequestRepository;
  let status: SyncStatusRepository;
  let workspaceId: string;
  let seq = 0;

  beforeAll(async () => {
    pg = await startPg();
    prs = new PullRequestRepository(pg.handle.db);
    status = new SyncStatusRepository(pg.handle.db);
    ({ workspaceId } = await seed(pg.handle.db));
  });
  afterAll(async () => {
    await pg?.stop();
  });

  async function newGitLabRepo(): Promise<SyncRepo> {
    seq += 1;
    const name = `proj-${seq}`;
    const [row] = await pg.handle.db
      .insert(t.repos)
      .values({
        workspaceId,
        owner: 'sync-group/sub',
        name,
        fullName: `sync-group/sub/${name}`,
        provider: 'gitlab',
        host: 'gitlab.com',
      })
      .returning();
    return row!;
  }

  async function rowsOf(repoId: string) {
    const rows = await pg.handle.db.select().from(t.pullRequests).where(eq(t.pullRequests.repoId, repoId));
    return new Map(rows.map((r) => [r.number, r]));
  }

  it('stats-unknown upsert leaves stats_known=false; a later known upsert fills the numbers (AC-54)', async () => {
    const repo = await newGitLabRepo();
    const scope = { workspaceId, repoId: repo.id };

    await prs.upsertListWithStats(scope, [
      mr(1, { stats_known: false, additions: 0, deletions: 0, files_count: 0, is_draft: true }),
      mr(2),
    ]);
    let rows = await rowsOf(repo.id);
    expect(rows.get(1)).toMatchObject({ statsKnown: false, isDraft: true, additions: 0, filesCount: 0 });
    expect(rows.get(2)).toMatchObject({ statsKnown: true, additions: 5, deletions: 2, filesCount: 1 });

    // MR 1 un-drafted with real stats; MR 2 now reports unknown stats → keeps its old numbers.
    await prs.upsertListWithStats(scope, [
      mr(1, { additions: 40, deletions: 7, files_count: 3, is_draft: false, head_sha: 'sha-1-b' }),
      mr(2, { stats_known: false, additions: 0, deletions: 0, files_count: 0, title: 'MR 2 renamed' }),
    ]);
    rows = await rowsOf(repo.id);
    expect(rows.get(1)).toMatchObject({
      statsKnown: true,
      isDraft: false,
      additions: 40,
      deletions: 7,
      filesCount: 3,
      headSha: 'sha-1-b',
    });
    expect(rows.get(2)).toMatchObject({ statsKnown: true, additions: 5, deletions: 2, filesCount: 1, title: 'MR 2 renamed' });
  });

  it('listOpenNumbers / updateStatuses reconcile MRs that left the open set (AC-28)', async () => {
    const repo = await newGitLabRepo();
    const scope = { workspaceId, repoId: repo.id };
    await prs.upsertListWithStats(scope, [mr(1), mr(2), mr(3, { status: 'merged' })]);

    expect(await prs.listOpenNumbers(scope)).toEqual([1, 2]);
    // Another workspace never sees or touches these rows.
    expect(await prs.listOpenNumbers({ workspaceId: '00000000-0000-0000-0000-000000000000', repoId: repo.id })).toEqual([]);
    expect(
      await prs.updateStatuses({ workspaceId: '00000000-0000-0000-0000-000000000000', repoId: repo.id }, [
        { number: 1, status: 'closed' },
      ]),
    ).toBe(0);

    expect(await prs.updateStatuses(scope, [{ number: 2, status: 'merged' }, { number: 99, status: 'closed' }])).toBe(1);
    expect(await prs.listOpenNumbers(scope)).toEqual([1]);
    expect((await rowsOf(repo.id)).get(2)!.status).toBe('merged');
  });

  it('listMissingStats returns zero-stat PRs, newest first, capped', async () => {
    const repo = await newGitLabRepo();
    const scope = { workspaceId, repoId: repo.id };
    await prs.upsertList(scope, [
      mr(1, { additions: 0, deletions: 0, files_count: 0 }),
      mr(2, { additions: 0, deletions: 0, files_count: 0 }),
      mr(3, { additions: 0, deletions: 0, files_count: 0 }),
    ]);
    const rows = await rowsOf(repo.id);
    await prs.updateDiffStats(workspaceId, rows.get(2)!.id, { additions: 1, deletions: 0, filesCount: 1 });

    const gaps = await prs.listMissingStats(scope, 1);
    expect(gaps).toEqual([{ id: rows.get(3)!.id, number: 3 }]);
    expect((await prs.listMissingStats(scope, 10)).map((g) => g.number)).toEqual([3, 1]);
  });

  it('replaceDetail swaps files/commits atomically, records host fields, and is workspace-scoped', async () => {
    const repo = await newGitLabRepo();
    const scope = { workspaceId, repoId: repo.id };
    await prs.upsertListWithStats(scope, [mr(5, { stats_known: false, additions: 0, deletions: 0, files_count: 0 })]);
    const prId = (await rowsOf(repo.id)).get(5)!.id;

    const detail: PrDetailHost = {
      ...mr(5, { additions: 12, deletions: 4, files_count: 2 }),
      body: 'Closes #12',
      files: [
        { path: 'src/new.ts', previous_path: 'src/old.ts', change_type: 'renamed', additions: 2, deletions: 1, patch: '@@ -1 +1 @@' },
        { path: 'big.json', change_type: 'modified', additions: 10, deletions: 3, patch: null, patch_omitted: 'too_large' },
      ],
      commits: [{ sha: 'c1', message: 'feat', author: 'dev', committed_at: '2026-10-01T00:00:00.000Z' }],
    };

    expect(
      await prs.replaceDetail('00000000-0000-0000-0000-000000000000', prId, detail, { isDraft: false, detailHeadSha: 'x' }),
    ).toBe(false);
    expect(await pg.handle.db.select().from(t.prFiles).where(eq(t.prFiles.prId, prId))).toHaveLength(0);

    expect(await prs.replaceDetail(workspaceId, prId, detail, { isDraft: true, detailHeadSha: 'sha-5-a' })).toBe(true);
    // Second replace must not duplicate rows.
    expect(await prs.replaceDetail(workspaceId, prId, detail, { isDraft: true, detailHeadSha: 'sha-5-a' })).toBe(true);

    const pr = (await rowsOf(repo.id)).get(5)!;
    expect(pr).toMatchObject({
      body: 'Closes #12',
      additions: 12,
      deletions: 4,
      filesCount: 2,
      statsKnown: true,
      isDraft: true,
      detailHeadSha: 'sha-5-a',
    });
    const files = await pg.handle.db.select().from(t.prFiles).where(eq(t.prFiles.prId, prId));
    expect(files).toHaveLength(2);
    expect(files.find((f) => f.path === 'src/new.ts')).toMatchObject({ previousPath: 'src/old.ts', changeType: 'renamed' });
    expect(files.find((f) => f.path === 'big.json')).toMatchObject({ patch: null, patchOmitted: 'too_large' });
    expect(await pg.handle.db.select().from(t.prCommits).where(eq(t.prCommits.prId, prId))).toHaveLength(1);

    // GitHub path (hostFields null) writes only body + stats — no host columns.
    await prs.upsertList(scope, [mr(6)]);
    const ghId = (await rowsOf(repo.id)).get(6)!.id;
    await prs.replaceDetail(workspaceId, ghId, { ...detail, number: 6, files: [], commits: [] }, null);
    expect((await rowsOf(repo.id)).get(6)).toMatchObject({ statsKnown: null, isDraft: null, detailHeadSha: null, additions: 12 });
  });

  it('getPersistedDetail returns files by path and commits oldest-first, deterministically', async () => {
    const repo = await newGitLabRepo();
    const scope = { workspaceId, repoId: repo.id };
    await prs.upsertListWithStats(scope, [mr(41)]);
    const prId = (await rowsOf(repo.id)).get(41)!.id;

    const file = (path: string) => ({ path, additions: 1, deletions: 0, patch: '@@', change_type: 'modified' as const });
    const detail: PrDetailHost = {
      ...mr(41),
      body: null,
      files: [file('src/z.ts'), file('a.md'), file('src/b.ts')],
      commits: [
        { sha: 'undated', message: 'm', author: 'dev', committed_at: null },
        { sha: 'c3', message: 'm', author: 'dev', committed_at: '2026-10-03T00:00:00.000Z' },
        { sha: 'c1b', message: 'm', author: 'dev', committed_at: '2026-10-01T00:00:00.000Z' },
        { sha: 'c1a', message: 'm', author: 'dev', committed_at: '2026-10-01T00:00:00.000Z' },
        { sha: 'c2', message: 'm', author: 'dev', committed_at: '2026-10-02T00:00:00.000Z' },
      ],
    };
    expect(await prs.replaceDetail(workspaceId, prId, detail, { isDraft: false, detailHeadSha: 'sha-41' })).toBe(true);

    for (let i = 0; i < 3; i++) {
      const persisted = await prs.getPersistedDetail(prId);
      expect(persisted.files.map((f) => f.path)).toEqual(['a.md', 'src/b.ts', 'src/z.ts']);
      expect(persisted.commits.map((c) => c.sha)).toEqual(['c1a', 'c1b', 'c2', 'c3', 'undated']);
    }
  });

  it('replaceDetail inserts 9 000 files in chunks (past the 65 535 bind-param cap) and stays atomic', async () => {
    const repo = await newGitLabRepo();
    const scope = { workspaceId, repoId: repo.id };
    await prs.upsertListWithStats(scope, [mr(40)]);
    const prId = (await rowsOf(repo.id)).get(40)!.id;

    const N = 9_000; // × 8 params/row = 72 000 > 65 535 — one INSERT would fail
    const files = Array.from({ length: N }, (_, i) => ({
      path: `src/f${i}.ts`,
      additions: 1,
      deletions: 0,
      patch: '@@ -0,0 +1 @@',
      change_type: 'added' as const,
    }));
    const detail: PrDetailHost = {
      ...mr(40, { additions: N, deletions: 0, files_count: N }),
      body: null,
      files,
      commits: [{ sha: 'c-big', message: 'huge', author: 'dev', committed_at: null }],
    };
    expect(await prs.replaceDetail(workspaceId, prId, detail, { isDraft: false, detailHeadSha: 'sha-40-a' })).toBe(true);

    const persisted = await prs.getPersistedDetail(prId);
    expect(persisted.files).toHaveLength(N);
    expect(persisted.commits).toEqual([{ sha: 'c-big', message: 'huge', author: 'dev', committedAt: null }]);
    expect(persisted.files.find((f) => f.path === 'src/f8999.ts')).toEqual({
      path: 'src/f8999.ts',
      additions: 1,
      deletions: 0,
      patch: '@@ -0,0 +1 @@',
      previousPath: null,
      changeType: 'added',
      patchOmitted: null,
    });

    // A failure in the LAST chunk (NOT NULL path) rolls back every earlier chunk
    // and the deletes: the previous 9 000 files + commit survive untouched.
    const broken: PrDetailHost = {
      ...detail,
      body: 'must not persist',
      files: [...files.slice(0, N - 1), { ...files[N - 1]!, path: null as unknown as string }],
      commits: [],
    };
    await expect(
      prs.replaceDetail(workspaceId, prId, broken, { isDraft: true, detailHeadSha: 'sha-40-b' }),
    ).rejects.toThrow();
    const after = await prs.getPersistedDetail(prId);
    expect(after.files).toHaveLength(N);
    expect(after.commits).toHaveLength(1);
    expect((await rowsOf(repo.id)).get(40)).toMatchObject({ body: null, detailHeadSha: 'sha-40-a' });
  });

  it('replaceDetail with unknown GitLab stats keeps prior numbers; known stats are written (AC-20/AC-54)', async () => {
    const repo = await newGitLabRepo();
    const scope = { workspaceId, repoId: repo.id };
    const base = (over: Partial<PrDetailHost>): PrDetailHost => ({
      ...mr(7),
      body: 'b',
      files: [{ path: 'big.json', change_type: 'modified', additions: 0, deletions: 0, patch: null, patch_omitted: 'too_large' }],
      commits: [],
      ...over,
    });

    // Never-known row: unknown detail leaves stats_known=false and the zeros.
    await prs.upsertListWithStats(scope, [mr(7, { stats_known: false, additions: 0, deletions: 0, files_count: 0 })]);
    const unknownId = (await rowsOf(repo.id)).get(7)!.id;
    const unknown = base({ stats_known: false, additions: 0, deletions: 0, files_count: 1 });
    expect(await prs.replaceDetail(workspaceId, unknownId, unknown, { isDraft: false, detailHeadSha: 'h7' })).toBe(true);
    expect((await rowsOf(repo.id)).get(7)).toMatchObject({
      statsKnown: false,
      additions: 0,
      deletions: 0,
      filesCount: 0,
      detailHeadSha: 'h7',
    });

    // Known row: unknown detail must not overwrite the persisted numbers.
    await prs.upsertListWithStats(scope, [mr(8, { additions: 30, deletions: 9, files_count: 4 })]);
    const knownId = (await rowsOf(repo.id)).get(8)!.id;
    await prs.replaceDetail(workspaceId, knownId, base({ number: 8, stats_known: false, additions: 0, deletions: 0, files_count: 1 }), {
      isDraft: true,
      detailHeadSha: 'h8',
    });
    expect((await rowsOf(repo.id)).get(8)).toMatchObject({
      statsKnown: true,
      additions: 30,
      deletions: 9,
      filesCount: 4,
      isDraft: true,
      detailHeadSha: 'h8',
    });

    // Known stats on the formerly-unknown row: written, stats_known flips true.
    await prs.replaceDetail(workspaceId, unknownId, base({ stats_known: true, additions: 11, deletions: 3, files_count: 1 }), {
      isDraft: false,
      detailHeadSha: 'h7b',
    });
    expect((await rowsOf(repo.id)).get(7)).toMatchObject({ statsKnown: true, additions: 11, deletions: 3, filesCount: 1 });
  });

  it('SyncStatusRepository records success / failure without losing the last success', async () => {
    const repo = await newGitLabRepo();
    expect(await status.get(workspaceId, repo.id)).toEqual({ lastSyncedAt: null, lastAttemptAt: null, lastSyncError: null });
    expect(await status.get('00000000-0000-0000-0000-000000000000', repo.id)).toBeNull();

    const ok = new Date('2026-10-16T10:00:00.000Z');
    const bad = new Date('2026-10-16T10:05:00.000Z');
    await status.recordSuccess(workspaceId, repo.id, ok);
    await status.recordFailure(workspaceId, repo.id, bad, 'GitLab 503');
    expect(await status.get(workspaceId, repo.id)).toEqual({ lastSyncedAt: ok, lastAttemptAt: bad, lastSyncError: 'GitLab 503' });
    await status.recordSuccess(workspaceId, repo.id, ok);
    expect((await status.get(workspaceId, repo.id))!.lastSyncError).toBeNull();
  });

  it('a detached sync persists last_synced_at; a re-open within the TTL is fresh (AC-64)', async () => {
    const repo = await newGitLabRepo();
    let listCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const host: PullRequestHost = {
      provider: 'gitlab',
      readOnly: true,
      listPullRequests: async (_ref: HostRepoRef) => {
        listCalls += 1;
        await gate;
        return [mr(1), mr(2)];
      },
      getPullStates: async () => [],
      getPullRequestDetail: async () => {
        throw new Error('no detail during sync');
      },
      getIssue: async () => null,
      getLinkedIssueNumber: async () => null,
    };
    let clock = Date.parse('2026-10-16T12:00:00.000Z');
    const svc = new PrListSyncService({ hosts: async () => host, store: prs });
    const coord = new PrSyncCoordinator<SyncRepo>({
      ttlMs: 60_000,
      backoffMs: 60_000,
      now: () => clock,
      status,
      run: (r) => svc.syncRepo(r),
    });

    expect(await coord.onOpen(repo)).toBe('started'); // caller walks away
    clock += 20_000;
    release();
    while (coord.isRunning(repo.id)) await new Promise((r) => setTimeout(r, 5));

    const persisted = await status.get(workspaceId, repo.id);
    expect(persisted!.lastSyncedAt?.toISOString()).toBe('2026-10-16T12:00:20.000Z');
    expect([...(await rowsOf(repo.id)).keys()].sort()).toEqual([1, 2]);

    clock += 30_000;
    expect(await coord.onOpen(repo)).toBe('fresh');
    expect(listCalls).toBe(1);
  });

  it('persists one 100-MR page with p95 ≤ 200 ms over 20 iterations (NFR per-page)', async () => {
    const repo = await newGitLabRepo();
    const scope = { workspaceId, repoId: repo.id };
    const durations: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const page = Array.from({ length: 100 }, (_, n) =>
        mr(n + 1, { title: `MR ${n + 1} v${i}`, head_sha: `sha-${n + 1}-${i}`, stats_known: n % 7 !== 0 }),
      );
      const started = performance.now();
      await prs.upsertListWithStats(scope, page);
      durations.push(performance.now() - started);
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.ceil(0.95 * durations.length) - 1]!;
    expect(p95).toBeLessThanOrEqual(200);
    expect((await rowsOf(repo.id)).size).toBe(100);
  });
});
