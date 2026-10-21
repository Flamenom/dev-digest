import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import * as t from '../src/db/schema.js';
import { PublishRepository } from '../src/modules/publish/repository.js';
import {
  FindingAlreadyPublishedError,
  PublishInProgressError,
  type CreatePublicationInput,
} from '../src/modules/publish/ports.js';
import { PUBLISH_UNCONFIRMED_MESSAGE } from '../src/modules/publish/codes.js';

/**
 * Plan T7 — `PublishRepository` against real Postgres: the per-PR lock under
 * concurrency (AC-22), the per-finding live guard (AC-35), the exactly-once CAS
 * `finish`, boot orphan flip (Q2), `published_by` and workspace scoping.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

d('PublishRepository', () => {
  let pg: PgFixture;
  let repo: PublishRepository;
  let wsA: string;
  let wsB: string;
  let userId: string;
  let repoSeq = 0;

  async function seedPr(workspaceId: string) {
    const db = pg.handle.db;
    repoSeq += 1;
    const [r] = await db
      .insert(t.repos)
      .values({
        workspaceId,
        owner: 'pubrepo-group',
        name: `proj-${repoSeq}`,
        fullName: `pubrepo-group/sub/proj-${repoSeq}`,
        provider: 'gitlab',
        host: 'gitlab.com',
      })
      .returning();
    const [pr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: r!.id,
        number: 5,
        title: 'MR',
        author: 'dev',
        branch: 'feat',
        base: 'main',
        headSha: 'abc',
        detailHeadSha: 'abc',
        status: 'open',
      })
      .returning();
    await db.insert(t.prFiles).values({
      prId: pr!.id,
      path: 'src/a.ts',
      patch: '@@ -1,1 +1,2 @@\n a\n+b',
      changeType: 'modified',
    });
    const reviews: string[] = [];
    const findings: string[][] = [];
    for (let i = 0; i < 2; i++) {
      const [rv] = await db
        .insert(t.reviews)
        .values({ workspaceId, prId: pr!.id, kind: 'review', headSha: 'abc' })
        .returning();
      const fs = await db
        .insert(t.findings)
        .values(
          [1, 2, 3].map((n) => ({
            reviewId: rv!.id,
            file: 'src/a.ts',
            startLine: n,
            endLine: n,
            severity: 'WARNING',
            category: 'bug',
            title: `F${n}`,
            rationale: 'r',
            confidence: 0.9,
          })),
        )
        .returning();
      reviews.push(rv!.id);
      findings.push(fs.map((f) => f.id));
    }
    return { repoId: r!.id, prId: pr!.id, reviews, findings };
  }

  function input(
    workspaceId: string,
    prId: string,
    reviewId: string,
    findingIds: string[],
  ): CreatePublicationInput {
    return {
      workspaceId,
      reviewId,
      prId,
      createdBy: userId,
      hasSummary: false,
      applySuggestions: false,
      items: findingIds.map((findingId, position) => ({
        findingId,
        position,
        anchorKind: 'single_line',
      })),
    };
  }

  beforeAll(async () => {
    pg = await startPg();
    repo = new PublishRepository(pg.handle.db);
    const db = pg.handle.db;
    const [a] = await db.insert(t.workspaces).values({ name: 'pub-ws-a' }).returning();
    const [b] = await db.insert(t.workspaces).values({ name: 'pub-ws-b' }).returning();
    const [u] = await db
      .insert(t.users)
      .values({ email: 'publisher@onlytraf.com', name: 'Pat Publisher' })
      .returning();
    wsA = a!.id;
    wsB = b!.id;
    userId = u!.id;
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it('AC-22: concurrent creates for two reviews of one PR → exactly one wins', async () => {
    const s = await seedPr(wsA);
    const results = await Promise.allSettled([
      repo.createPublication(input(wsA, s.prId, s.reviews[0]!, s.findings[0]!)),
      repo.createPublication(input(wsA, s.prId, s.reviews[1]!, s.findings[1]!)),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    const winner = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof repo.createPublication>>>)
      .value;
    const reason = (bad[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(PublishInProgressError);
    expect((reason as PublishInProgressError).runningPublicationId).toBe(winner.id);

    expect(winner).toMatchObject({
      status: 'in_progress',
      requested: 3,
      drafted: 0,
      createdBy: { id: userId, name: 'Pat Publisher' },
    });
    expect(winner.items.map((i) => i.state)).toEqual(['pending', 'pending', 'pending']);
    expect(winner.items.map((i) => i.position)).toEqual([0, 1, 2]);
    expect(await repo.inProgressForPr(s.prId)).toEqual({ id: winner.id, reviewId: winner.reviewId });

    // Only the winner's rows exist.
    const pubs = await pg.handle.db
      .select()
      .from(t.reviewPublications)
      .where(eq(t.reviewPublications.prId, s.prId));
    expect(pubs).toHaveLength(1);
  });

  it('AC-35: a finding with a published item → FindingAlreadyPublishedError, nothing inserted', async () => {
    const s = await seedPr(wsA);
    const [f1, f2] = s.findings[0]!;
    const first = await repo.createPublication(input(wsA, s.prId, s.reviews[0]!, [f1!]));
    await repo.markItemDrafted(first.id, f1!, 101);
    await repo.markItemsPublished(first.id, [
      {
        findingId: f1!,
        discussionId: 'd1',
        noteId: 9001,
        url: 'https://gitlab.com/pubrepo-group/x/-/merge_requests/5#note_9001',
        publishedAt: new Date('2026-10-21T10:00:00Z'),
      },
    ]);
    expect(
      await repo.finish(first.id, ['in_progress'], {
        status: 'published',
        code: null,
        message: null,
        finishedAt: new Date(),
      }),
    ).toBe(true);

    const before = await pg.handle.db.select().from(t.reviewPublications);
    const err = await repo
      .createPublication(input(wsA, s.prId, s.reviews[0]!, [f2!, f1!]))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FindingAlreadyPublishedError);
    expect((err as FindingAlreadyPublishedError).findingIds).toEqual([f1]);
    const after = await pg.handle.db.select().from(t.reviewPublications);
    expect(after).toHaveLength(before.length);
    // The PR lock was released by the rollback too.
    expect(await repo.inProgressForPr(s.prId)).toBeNull();

    const reloaded = await repo.getPublication(wsA, first.id);
    expect(reloaded).toMatchObject({ status: 'published', drafted: 1, published: 1 });
    expect(reloaded!.finishedAt).toBeInstanceOf(Date);
    expect(reloaded!.items[0]).toMatchObject({
      state: 'published',
      draftId: 101,
      discussionId: 'd1',
      noteId: 9001,
    });
  });

  it('finish is a CAS: the first call wins, the second returns false', async () => {
    const s = await seedPr(wsA);
    const pub = await repo.createPublication(input(wsA, s.prId, s.reviews[0]!, s.findings[0]!));
    const patch = {
      status: 'failed' as const,
      code: 'gitlab_publish_failed' as const,
      message: 'x',
      finishedAt: new Date(),
      counters: { failed: 3 },
    };
    expect(await repo.finish(pub.id, ['in_progress'], patch)).toBe(true);
    expect(await repo.finish(pub.id, ['in_progress'], patch)).toBe(false);
    const rec = await repo.getPublication(wsA, pub.id);
    expect(rec).toMatchObject({ status: 'failed', code: 'gitlab_publish_failed', failed: 3 });
    expect(rec!.finishedAt).toBeInstanceOf(Date);
  });

  it('markOrphanedUnconfirmed flips only in_progress rows, with the AC-33 code + message', async () => {
    const running = await seedPr(wsA);
    const done = await seedPr(wsA);
    const p1 = await repo.createPublication(
      input(wsA, running.prId, running.reviews[0]!, running.findings[0]!),
    );
    const p2 = await repo.createPublication(input(wsA, done.prId, done.reviews[0]!, done.findings[0]!));
    await repo.finish(p2.id, ['in_progress'], {
      status: 'published',
      code: null,
      message: null,
      finishedAt: new Date(),
    });

    const flipped = await repo.markOrphanedUnconfirmed();
    expect(flipped).toBeGreaterThanOrEqual(1);
    expect(await repo.getPublication(wsA, p1.id)).toMatchObject({
      status: 'unconfirmed',
      code: 'gitlab_publish_unconfirmed',
      message: PUBLISH_UNCONFIRMED_MESSAGE,
      finishedAt: null,
    });
    expect(await repo.getPublication(wsA, p2.id)).toMatchObject({ status: 'published', code: null });

    // `unconfirmed` is a reconcile candidate regardless of age; items stay live (AC-33).
    const cands = await repo.reconcileCandidates({ prId: running.prId, staleBefore: new Date(0) });
    expect(cands.map((c) => c.id)).toEqual([p1.id]);
    const states = await repo.findingStates(running.findings[0]!);
    expect(states.every((st) => st.publicationStatus === 'unconfirmed')).toBe(true);
    expect(states).toHaveLength(3);
  });

  it('findingStates carries published_by name; stale in_progress is a reconcile candidate', async () => {
    const s = await seedPr(wsA);
    const [f1, f2] = s.findings[0]!;
    const pub = await repo.createPublication(input(wsA, s.prId, s.reviews[0]!, [f1!, f2!]));
    await repo.markItemDrafted(pub.id, f1!, 7);
    await repo.markItemFailed(pub.id, f2!, 'gitlab_position_rejected');
    await repo.markItemsPublished(pub.id, [
      { findingId: f1!, discussionId: null, noteId: null, url: null, publishedAt: new Date() },
    ]);

    const states = await repo.findingStates([f1!, f2!]);
    expect(states).toHaveLength(1); // the failed item is not live
    expect(states[0]).toMatchObject({
      findingId: f1,
      publicationId: pub.id,
      state: 'published',
      url: null,
      publishedBy: { id: userId, name: 'Pat Publisher' },
    });

    const rec = await repo.getPublication(wsA, pub.id);
    expect(rec).toMatchObject({ drafted: 1, failed: 1, published: 1 });
    expect(rec!.items[1]).toMatchObject({ state: 'failed', code: 'gitlab_position_rejected' });

    expect(await repo.reconcileCandidates({ prId: s.prId, staleBefore: new Date(0) })).toEqual([]);
    const stale = await repo.reconcileCandidates({
      prId: s.prId,
      staleBefore: new Date(Date.now() + 60_000),
    });
    expect(stale.map((c) => c.id)).toEqual([pub.id]);
  });

  it('rollbacks never un-publish; leftover findings of other publications are rolled back', async () => {
    const s = await seedPr(wsA);
    const [f1, f2, f3] = s.findings[0]!;
    const old = await repo.createPublication(input(wsA, s.prId, s.reviews[0]!, [f1!, f2!]));
    await repo.markItemDrafted(old.id, f1!, 1);
    await repo.markItemDrafted(old.id, f2!, 2);
    await repo.markItemsPublished(old.id, [
      { findingId: f1!, discussionId: 'd', noteId: 1, url: null, publishedAt: new Date() },
    ]);
    await repo.markOrphanedUnconfirmed();

    await repo.rollBackLeftoverFindings([old.id], [f1!, f2!]);
    const oldRec = await repo.getPublication(wsA, old.id);
    expect(oldRec!.items.map((i) => i.state)).toEqual(['published', 'rolled_back']);

    // f2 is free again; f1 stays blocked.
    const next = await repo.createPublication(input(wsA, s.prId, s.reviews[0]!, [f2!, f3!]));
    await repo.markItemsRolledBack(next.id, [f2!, f3!]);
    expect((await repo.getPublication(wsA, next.id))!.items.map((i) => i.state)).toEqual([
      'rolled_back',
      'rolled_back',
    ]);
  });

  it('workspace scoping: workspace B cannot read workspace A data', async () => {
    const s = await seedPr(wsA);
    const pub = await repo.createPublication(input(wsA, s.prId, s.reviews[0]!, s.findings[0]!));
    expect(await repo.getPublication(wsB, pub.id)).toBeNull();
    expect(await repo.listForReview(wsB, s.reviews[0]!)).toEqual([]);
    expect(await repo.loadReviewContext(wsB, s.reviews[0]!)).toBeNull();
    expect((await repo.listForReview(wsA, s.reviews[0]!)).map((p) => p.id)).toEqual([pub.id]);
    expect(await repo.getPublication(wsA, 'not-a-uuid')).toBeNull();
  });

  it('loadReviewContext returns PR, repo identity, findings and pr_files', async () => {
    const s = await seedPr(wsA);
    const ctx = await repo.loadReviewContext(wsA, s.reviews[0]!);
    expect(ctx).not.toBeNull();
    expect(ctx!.review).toMatchObject({ id: s.reviews[0], workspaceId: wsA, headSha: 'abc' });
    expect(ctx!.pr).toMatchObject({ number: 5, status: 'open', headSha: 'abc', detailHeadSha: 'abc' });
    expect(ctx!.repo.provider).toBe('gitlab');
    expect(ctx!.repo.ref).toMatchObject({ provider: 'gitlab', host: 'gitlab.com' });
    expect(ctx!.repo.webUrl).toBe(`https://gitlab.com/${ctx!.repo.ref.fullName}`);
    expect(ctx!.findings).toHaveLength(3);
    expect(ctx!.findings[0]).toMatchObject({
      severity: 'WARNING',
      kind: 'finding',
      evidence: null,
      dismissed_at: null,
    });
    expect(ctx!.files).toEqual([
      {
        path: 'src/a.ts',
        patch: '@@ -1,1 +1,2 @@\n a\n+b',
        previousPath: null,
        patchOmitted: null,
        changeType: 'modified',
      },
    ]);
  });

  it('deletePublication cascades items and releases the PR lock', async () => {
    const s = await seedPr(wsA);
    const pub = await repo.createPublication(input(wsA, s.prId, s.reviews[0]!, s.findings[0]!));
    await repo.setOtherDrafts(pub.id, 2);
    await repo.setBulkPublishSent(pub.id, new Date('2026-10-21T00:00:00Z'));
    await repo.touch(pub.id);
    expect(await repo.getPublication(wsA, pub.id)).toMatchObject({ otherDraftsPublished: 2 });
    await repo.deletePublication(pub.id);
    expect(await repo.getPublication(wsA, pub.id)).toBeNull();
    expect(await repo.inProgressForPr(s.prId)).toBeNull();
    const items = await pg.handle.db
      .select()
      .from(t.reviewPublicationItems)
      .where(eq(t.reviewPublicationItems.publicationId, pub.id));
    expect(items).toEqual([]);
    // The findings are free again.
    await expect(
      repo.createPublication(input(wsA, s.prId, s.reviews[1]!, s.findings[0]!)),
    ).resolves.toMatchObject({ status: 'in_progress' });
  });
});
