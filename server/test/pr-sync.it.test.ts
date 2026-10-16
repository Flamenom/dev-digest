import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PrMeta } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { upsertPullRequestList } from '../src/modules/_shared/repository/pr-sync.js';

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
  } as PrMeta;
}

d('upsertPullRequestList (batched PR-list sync)', () => {
  let pg: PgFixture;

  beforeAll(async () => {
    pg = await startPg();
  });
  afterAll(async () => {
    await pg?.stop();
  });

  it('inserts many PRs in one call, then refreshes only the mutable fields on conflict', async () => {
    const { db } = pg.handle;
    const { workspaceId } = await seed(db);
    const [repo] = await db
      .insert(t.repos)
      .values({ workspaceId, owner: 'sync', name: 'batch', fullName: 'sync/batch' })
      .returning();
    const scope = { workspaceId, repoId: repo!.id };

    expect(await upsertPullRequestList(db, scope, [])).toBe(0);
    expect(await upsertPullRequestList(db, scope, [pr(1), pr(2), pr(3)])).toBe(3);

    // Simulate the detail backfill having filled real diff stats for PR 1.
    await db
      .update(t.pullRequests)
      .set({ additions: 10, deletions: 4, filesCount: 2 })
      .where(eq(t.pullRequests.number, 1));

    // GitHub reports PR 1 moved (new head, title, status); PR 4 is new.
    await upsertPullRequestList(db, scope, [
      pr(1, {
        title: 'PR 1 (renamed)',
        head_sha: 'sha-1-b',
        status: 'merged',
        author: 'someone-else',
        updated_at: '2026-01-05T00:00:00.000Z',
      }),
      pr(4),
    ]);

    const rows = await db
      .select()
      .from(t.pullRequests)
      .where(eq(t.pullRequests.repoId, repo!.id));
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
});
