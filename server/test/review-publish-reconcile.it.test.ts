import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Publication, PublishPreview } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import type { FetchLike } from '../src/adapters/gitlab/index.js';
import { FakeGitLab } from './helpers/fake-gitlab.js';
import {
  PUB_IID,
  SERVICE_ACCOUNT,
  addPublishMr,
  buildLocalPublishApp,
  getPublication,
  newPublishFake,
  seedPublishPr,
  settle,
} from './helpers/publish-fixtures.js';

/**
 * Plan T11 — reconciliation of publications whose outcome is unknown (spec
 * 2026-10-21-gitlab-publish-findings AC-32 – AC-34; plan Q2, Q3): a server
 * that dies mid-batch, an `unconfirmed` publication settled on the next read,
 * and the 10-minute rule for orphaned `in_progress` rows at runtime.
 * Reconciliation only READS GitLab (plus idempotent deletes of marked drafts) —
 * it never creates a draft and never calls `bulk_publish`.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;
if (!hasDocker) console.warn('[review-publish-reconcile] Docker not available — skipping.');

const TERMINAL = new Set(['published', 'partially_published', 'failed']);
const NOW = { 'retry-after': '0' };

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * The fetch of a process that dies on its `dieOnCreate`-th draft create: from
 * then on every request of THIS app hangs (a dead process answers nothing)
 * until `bury()`, which rejects them all as network errors.
 */
function dyingFetch(fake: FakeGitLab, dieOnCreate: number) {
  let creates = 0;
  let dead = false;
  let buried = false;
  const hung: ((err: Error) => void)[] = [];
  const fetch: FetchLike = (input, init) => {
    if (buried) return Promise.reject(new TypeError('fetch failed'));
    const isCreate = (init.method ?? 'GET').toUpperCase() === 'POST' && /\/draft_notes$/.test(new URL(input).pathname);
    if (isCreate && ++creates === dieOnCreate) dead = true;
    if (dead) return new Promise<Response>((_, reject) => hung.push(reject));
    return fake.fetch(input, init);
  };
  return {
    fetch,
    get dead() {
      return dead;
    },
    bury() {
      buried = true;
      for (const reject of hung.splice(0)) reject(new TypeError('fetch failed'));
    },
  };
}

d('publish findings to GitLab — reconciliation (fake GitLab, Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let fake: FakeGitLab;
  let seq = 0;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    pg = await startPg();
    ({ workspaceId } = await seed(pg.handle.db));
    fake = newPublishFake();
  });
  afterAll(async () => {
    for (const app of apps) await app.close().catch(() => undefined);
    await pg?.stop();
  });

  async function setup() {
    seq += 1;
    const fullPath = `gl-recon/team-${seq}/svc`;
    addPublishMr(fake, fullPath);
    const seeded = await seedPublishPr(pg.handle.db, { workspaceId, fullPath });
    return { ...seeded, fullPath, all: Object.values(seeded.ids) };
  }

  it('AC-34: the server dies mid-batch (closed without draining) → after a restart the publication is terminal and the fake holds 0 marked drafts', async () => {
    const s = await setup();
    const dying = dyingFetch(fake, 3);
    const first = await buildLocalPublishApp(pg, fake, { fetch: dying.fetch });
    const res = await first.inject({
      method: 'POST',
      url: `/reviews/${s.reviewId}/publications`,
      payload: { finding_ids: s.all },
    });
    expect(res.statusCode).toBe(202);
    const id = (res.json() as Publication).id;

    // Two drafts landed and are recorded; the 3rd create never answers.
    const mid = await until(
      () => getPublication(first, id),
      (p) => p.drafted === 2 && dying.dead,
    );
    expect(mid).toMatchObject({ status: 'in_progress', drafted: 2 });
    expect(fake.markerCount(s.fullPath, PUB_IID, 'drafts', { publicationId: id })).toBe(2);

    // Shut down WITHOUT draining: close() only waits its bounded grace; the task stays hung.
    await first.close();
    expect(first.container.publishRunner.isActive(id)).toBe(true);

    fake.reset();
    const restarted = await buildLocalPublishApp(pg, fake);
    apps.push(restarted);
    const settled = await until(
      async () => (await pg.handle.db.select().from(t.reviewPublications).where(eq(t.reviewPublications.id, id)))[0]!,
      (row) => TERMINAL.has(row.status),
    );
    expect(settled.status).toBe('failed');
    expect(settled.code).toBe('gitlab_publish_failed'); // bulk_publish never sent ⇒ nothing published
    expect(settled.finishedAt).not.toBeNull();
    expect(fake.markerCount(s.fullPath, PUB_IID, 'all')).toBe(0);
    // Reads + deletes only: no create, no bulk_publish.
    expect(fake.writes).toEqual([]);
    expect(fake.deletes).toHaveLength(2);
    const pub = await getPublication(restarted, id);
    expect(pub.items.every((i) => i.state === 'rolled_back')).toBe(true);

    // The dead process finally errors out: it must not resurrect the publication.
    dying.bury();
    await settle(first);
    expect((await getPublication(restarted, id)).status).toBe('failed');
    expect(fake.writes).toEqual([]);
  });

  it('AC-33 → AC-34 (Q3): an unconfirmed publication is reconciled after a preview request, on the next read', async () => {
    const s = await setup();
    const app = await buildLocalPublishApp(pg, fake);
    apps.push(app);
    fake.reset();
    // bulk_publish lands but answers 504, and every discussions read fails.
    fake.when('POST', /\/bulk_publish$/, { status: 504, applyFirst: true });
    fake.when('GET', /\/discussions$/, { status: 500, headers: NOW }, 1_000);
    const res = await app.inject({
      method: 'POST',
      url: `/reviews/${s.reviewId}/publications`,
      payload: { finding_ids: s.all },
    });
    expect(res.statusCode).toBe(202);
    const id = (res.json() as Publication).id;
    await settle(app);
    expect((await getPublication(app, id)).status).toBe('unconfirmed');

    // GitLab readable again. The preview answers from the DB right away
    // (still unconfirmed) and triggers the reconcile in the background.
    fake.reset();
    const first = await app.inject({ method: 'GET', url: `/reviews/${s.reviewId}/publish-preview` });
    const before = first.json() as PublishPreview;
    expect(before.findings.every((f) => f.reason === 'publish_unconfirmed')).toBe(true);
    await settle(app);

    const after = await getPublication(app, id);
    expect(after).toMatchObject({ status: 'published', published: 4, code: null });
    expect(after.items.every((i) => i.state === 'published' && i.link?.url?.startsWith('https://'))).toBe(true);
    const next = (await app.inject({ method: 'GET', url: `/reviews/${s.reviewId}/publish-preview` })).json() as PublishPreview;
    expect(next.findings.every((f) => f.reason === 'already_published')).toBe(true);
    // Reconciliation only read (+ nothing to delete): bulk_publish was not re-sent.
    expect(fake.writes).toEqual([]);
  });

  it('AC-34: at runtime only in_progress rows older than 10 min (not live here) are reconciled; a fresh one is left alone', async () => {
    const s = await setup();
    const app = await buildLocalPublishApp(pg, fake);
    apps.push(app);
    const repo = app.container.publishRepo;
    const mk = (findingId: string) =>
      repo.createPublication({
        workspaceId,
        reviewId: s.reviewId,
        prId: s.prId,
        createdBy: null,
        hasSummary: false,
        applySuggestions: false,
        items: [{ findingId, position: 0, anchorKind: 'single_line' }],
      });

    // An orphan from a dead task: one drafted item whose marked draft is still on GitLab.
    const stale = await mk(s.ids.single!);
    const draft = fake.addHumanDraft(
      s.fullPath,
      PUB_IID,
      SERVICE_ACCOUNT,
      `x\n\n<!-- devdigest:publish:v1 w=${workspaceId} p=${stale.id} f=${s.ids.single} -->`,
    );
    await repo.markItemDrafted(stale.id, s.ids.single!, draft.id);
    await pg.handle.db.execute(
      sql`update review_publications set updated_at = now() - interval '11 minutes' where id = ${stale.id}`,
    );

    fake.reset();
    await app.inject({ method: 'GET', url: `/reviews/${s.reviewId}/publications` });
    await settle(app);
    const settled = await getPublication(app, stale.id);
    expect(settled).toMatchObject({ status: 'failed', code: 'gitlab_publish_failed' });
    expect(fake.drafts(s.fullPath, PUB_IID)).toEqual([]);
    expect(fake.writes).toEqual([]);

    // A fresh in_progress row (< 10 min): not touched, no GitLab request.
    const fresh = await mk(s.ids.multi!);
    fake.reset();
    await app.inject({ method: 'GET', url: `/reviews/${s.reviewId}/publish-preview` });
    await settle(app);
    expect((await getPublication(app, fresh.id)).status).toBe('in_progress');
    expect(fake.requests).toEqual([]);
  });
});
