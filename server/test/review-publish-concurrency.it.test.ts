import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Publication } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { FakeGitLab } from './helpers/fake-gitlab.js';
import {
  PUB_IID,
  addPublishMr,
  buildLocalPublishApp,
  getPublication,
  mrApiPath,
  newPublishFake,
  seedPublishPr,
  settle,
} from './helpers/publish-fixtures.js';

/**
 * Plan T11 — the per-PR publish lock and the per-finding live guard under
 * CONCURRENT requests (spec 2026-10-21-gitlab-publish-findings AC-22, AC-35).
 * Both are Postgres partial unique indexes, so the race is decided by the DB.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;
if (!hasDocker) console.warn('[review-publish-concurrency] Docker not available — skipping.');

d('publish findings to GitLab — concurrency (fake GitLab, Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let fake: FakeGitLab;
  let app: FastifyInstance;
  let seq = 0;

  beforeAll(async () => {
    pg = await startPg();
    ({ workspaceId } = await seed(pg.handle.db));
    fake = newPublishFake();
    app = await buildLocalPublishApp(pg, fake);
  });
  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await pg?.stop();
  });
  beforeEach(() => fake.reset());

  async function setup(reviews = 1) {
    seq += 1;
    const fullPath = `gl-conc/team-${seq}/svc`;
    addPublishMr(fake, fullPath);
    const seeded = await seedPublishPr(pg.handle.db, { workspaceId, fullPath, reviews });
    return { ...seeded, fullPath };
  }

  const post = (reviewId: string, findingIds: string[]) =>
    app.inject({ method: 'POST', url: `/reviews/${reviewId}/publications`, payload: { finding_ids: findingIds } });

  it('AC-22: two simultaneous POSTs for DIFFERENT reviews of one PR → one 202 + one 409 publish_in_progress (with the id); one batch reaches GitLab', async () => {
    const s = await setup(2);
    // Warm the token gate so both requests race only on the lock.
    expect((await app.inject({ method: 'GET', url: `/reviews/${s.reviewIds[0]}/publish-other-drafts` })).statusCode).toBe(200);
    fake.reset();

    const [a, b] = await Promise.all([post(s.reviewIds[0]!, s.findingIds[0]!), post(s.reviewIds[1]!, s.findingIds[1]!)]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([202, 409]);
    const winner = (a.statusCode === 202 ? a : b).json() as Publication;
    const loser = (a.statusCode === 409 ? a : b).json() as { error: { code: string; details?: { publication_id?: string } } };
    expect(loser.error.code).toBe('publish_in_progress');
    expect(loser.error.details?.publication_id).toBe(winner.id);

    await settle(app);
    expect((await getPublication(app, winner.id)).status).toBe('published');
    // One batch: the winner's 4 creates, ONE bulk, ONE diff-refs read (the loser made 0 GitLab requests).
    const creates = fake.matching(`${mrApiPath(s.fullPath)}/draft_notes`, 'POST').filter((r) => r.path.endsWith('/draft_notes'));
    expect(creates).toHaveLength(4);
    for (const c of creates) expect((c.body as { note: string }).note).toContain(`p=${winner.id}`);
    expect(fake.matching(/\/bulk_publish$/, 'POST')).toHaveLength(1);
    expect(fake.matching(new RegExp(`${mrApiPath(s.fullPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), 'GET')).toHaveLength(1);

    const rows = await pg.handle.db.select().from(t.reviewPublications).where(eq(t.reviewPublications.prId, s.prId));
    expect(rows).toHaveLength(1);
  });

  it('AC-22: concurrent POSTs for the SAME review (many at once) → exactly one 202', async () => {
    const s = await setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => post(s.reviewId, [s.ids.single!])));
    expect(results.filter((r) => r.statusCode === 202)).toHaveLength(1);
    for (const r of results.filter((x) => x.statusCode !== 202)) {
      expect(r.statusCode, r.body).toBe(409);
      expect(['publish_in_progress', 'finding_already_published']).toContain(r.json().error.code);
    }
    await settle(app);
    expect(fake.markerCount(s.fullPath, PUB_IID, 'notes', { findingId: s.ids.single })).toBe(1);
  });

  it('AC-35: a published finding in a new request → 409 finding_already_published, 0 GitLab requests', async () => {
    const s = await setup();
    const first = await post(s.reviewId, [s.ids.multi!]);
    expect(first.statusCode).toBe(202);
    await settle(app);
    fake.reset();

    const again = await post(s.reviewId, [s.ids.multi!, s.ids.single!]);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({
      code: 'finding_already_published',
      details: { finding_ids: [s.ids.multi] },
    });
    expect(fake.requests).toEqual([]);
    expect(fake.markerCount(s.fullPath, PUB_IID, 'notes', { findingId: s.ids.multi })).toBe(1);
  });
});
