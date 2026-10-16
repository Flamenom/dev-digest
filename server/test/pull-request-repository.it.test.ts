import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PrMeta } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { PullRequestRepository } from '../src/modules/pulls/repository.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

function pr(number: number, over: Partial<PrMeta> = {}): PrMeta {
  return {
    number,
    title: `PR ${number}`,
    author: 'octo',
    branch: `feat/${number}`,
    base: 'main',
    head_sha: `sha-${number}-a`,
    additions: 0,
    deletions: 0,
    files_count: 0,
    status: 'needs_review',
    opened_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...over,
  } satisfies PrMeta;
}

d('PullRequestRepository', () => {
  let pg: PgFixture;
  let repo: PullRequestRepository;
  let workspaceId: string;

  beforeAll(async () => {
    pg = await startPg();
    repo = new PullRequestRepository(pg.handle.db);
    ({ workspaceId } = await seed(pg.handle.db));
  });
  afterAll(async () => {
    await pg?.stop();
  });

  async function newRepo(name: string): Promise<string> {
    const [row] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'sync', name, fullName: `sync/${name}` })
      .returning();
    return row!.id;
  }

  async function prsOf(repoId: string) {
    return pg.handle.db.select().from(t.pullRequests).where(eq(t.pullRequests.repoId, repoId));
  }

  it('upsertList inserts many PRs in one call, then refreshes only the mutable fields on conflict', async () => {
    const repoId = await newRepo('batch');
    const scope = { workspaceId, repoId };

    expect(await repo.upsertList(scope, [])).toBe(0);
    expect(await repo.upsertList(scope, [pr(1), pr(2), pr(3)])).toBe(3);

    const first = (await prsOf(repoId)).find((r) => r.number === 1)!;
    await repo.updateDiffStats(workspaceId, first.id, { additions: 10, deletions: 4, filesCount: 2 });

    // GitHub reports PR 1 moved (new head, title, status); PR 4 is new.
    await repo.upsertList(scope, [
      pr(1, {
        title: 'PR 1 (renamed)',
        head_sha: 'sha-1-b',
        status: 'merged',
        author: 'someone-else',
        updated_at: '2026-01-05T00:00:00.000Z',
      }),
      pr(4),
    ]);

    const rows = await prsOf(repoId);
    expect(rows.map((r) => r.number).sort()).toEqual([1, 2, 3, 4]);

    const one = rows.find((r) => r.number === 1)!;
    expect(one.title).toBe('PR 1 (renamed)');
    expect(one.headSha).toBe('sha-1-b');
    expect(one.status).toBe('merged');
    expect(one.updatedAt?.toISOString()).toBe('2026-01-05T00:00:00.000Z');
    // Not overwritten by the list payload's zeros / first-seen values kept.
    expect([one.additions, one.deletions, one.filesCount]).toEqual([10, 4, 2]);
    expect(one.author).toBe('octo');
    expect(one.openedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('updateDiffStats is a no-op for another workspace', async () => {
    const repoId = await newRepo('tenancy');
    await repo.upsertList({ workspaceId, repoId }, [pr(1)]);
    const [row] = await prsOf(repoId);

    await repo.updateDiffStats('00000000-0000-0000-0000-000000000000', row!.id, {
      additions: 99,
      deletions: 99,
      filesCount: 99,
    });

    const [after] = await prsOf(repoId);
    expect([after!.additions, after!.deletions, after!.filesCount]).toEqual([0, 0, 0]);
  });

  it('composes into a caller-owned transaction (rolled back together)', async () => {
    const repoId = await newRepo('tx');
    await expect(
      pg.handle.db.transaction(async (tx) => {
        await repo.upsertList({ workspaceId, repoId }, [pr(1), pr(2)], tx);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await prsOf(repoId)).toHaveLength(0);
  });
});
