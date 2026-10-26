import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PublicationWithDeprecation as Publication, PublishPreview } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { seed } from '../src/db/seed.js';
import { FakeGitLab, type FakeRequest } from './helpers/fake-gitlab.js';
import {
  PUB_IID,
  SERVICE_ACCOUNT,
  addPublishMr,
  buildLocalPublishApp,
  getPublication,
  mrApiPath,
  newPublishFake,
  seedDeprecatedReview,
  seedPublishPr,
  settle,
} from './helpers/publish-fixtures.js';

/**
 * Plan T11 — every partial-failure path of a publish, end to end over the fake
 * gitlab.com (spec 2026-10-21-gitlab-publish-findings AC-13, AC-27 – AC-33,
 * AC-35). Invariants checked throughout: a draft create / `bulk_publish` is
 * never re-sent after an unconfirmed answer, other drafts are never touched,
 * and a finding never ends up with more than one note on the MR.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;
if (!hasDocker) console.warn('[review-publish-failures] Docker not available — skipping.');

const UNCONFIRMED = "GitLab didn't confirm the publish — check the MR before publishing again.";
/** Immediate retries: no real backoff sleeps in the suite. */
const NOW = { 'retry-after': '0' };

d('publish findings to GitLab — failure paths (fake GitLab, Testcontainers pg)', () => {
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

  async function setup() {
    seq += 1;
    const fullPath = `gl-fail/team-${seq}/svc`;
    addPublishMr(fake, fullPath);
    const seeded = await seedPublishPr(pg.handle.db, { workspaceId, fullPath });
    /** Send order (severity → file → line). */
    const ordered = [seeded.ids.multi!, seeded.ids.single!, seeded.ids.withheld!, seeded.ids.offdiff!];
    return { ...seeded, fullPath, ordered };
  }

  async function publishAndSettle(reviewId: string, payload: Record<string, unknown>): Promise<Publication> {
    const res = await app.inject({ method: 'POST', url: `/reviews/${reviewId}/publications`, payload });
    expect(res.statusCode, res.body).toBe(202);
    await settle(app);
    return getPublication(app, (res.json() as Publication).id);
  }

  const creates = (fullPath: string) =>
    fake.matching(`${mrApiPath(fullPath)}/draft_notes`, 'POST').filter((r) => r.path.endsWith('/draft_notes'));
  const bulks = (fullPath: string) => fake.matching(`${mrApiPath(fullPath)}/draft_notes/bulk_publish`, 'POST');
  const createsFor = (fullPath: string, findingId: string) =>
    creates(fullPath).filter((r) => (r.body as { note: string }).note.includes(`f=${findingId}`));
  const positionOf = (r: FakeRequest) => (r.body as { position?: Record<string, unknown> }).position;

  /** AC-35 invariant: at most one note per finding on the MR, ever. */
  function expectAtMostOneNotePerFinding(fullPath: string, findingIds: readonly string[]) {
    for (const f of findingIds) {
      expect(fake.markerCount(fullPath, PUB_IID, 'notes', { findingId: f }), `notes of ${f}`).toBeLessThanOrEqual(1);
    }
  }

  it('AC-13: a 400 on a multi-line draft → re-sent ONCE as single-line at end; the finding is published', async () => {
    const s = await setup();
    fake.when('POST', /\/draft_notes$/, { status: 400, body: { message: '400 line_range is invalid' } });
    const pub = await publishAndSettle(s.reviewId, { finding_ids: [s.ids.multi!, s.ids.single!] });
    expect(pub).toMatchObject({ status: 'published', published: 2, failed: 0 });

    const multi = createsFor(s.fullPath, s.ids.multi!);
    expect(multi).toHaveLength(2);
    expect(positionOf(multi[0]!)!.line_range).toBeDefined();
    expect(positionOf(multi[1]!)!).not.toHaveProperty('line_range');
    expect(positionOf(multi[1]!)!).toMatchObject({ new_line: 4 });
    expect(bulks(s.fullPath)).toHaveLength(1);
    expectAtMostOneNotePerFinding(s.fullPath, s.ordered);
  });

  it('AC-27: a confirmed-published finding whose note is not found by marker → published, link null; never re-published', async () => {
    const s = await setup();
    fake.hideNote((n) => n.body.includes(`f=${s.ids.single}`));
    const pub = await publishAndSettle(s.reviewId, { finding_ids: [s.ids.multi!, s.ids.single!] });
    expect(pub.status).toBe('published');
    const single = pub.items.find((i) => i.finding_id === s.ids.single)!;
    expect(single.state).toBe('published');
    expect(single.link).toMatchObject({ url: null, note_id: null, discussion_id: null });
    expect(pub.items.find((i) => i.finding_id === s.ids.multi)!.link!.url).toMatch(/^https:\/\/gitlab\.com\//);

    // Not selectable again (already published) → 409, 0 GitLab writes.
    fake.reset();
    const again = await app.inject({
      method: 'POST',
      url: `/reviews/${s.reviewId}/publications`,
      payload: { finding_ids: [s.ids.single!] },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('finding_already_published');
    expect(fake.writes).toEqual([]);
  });

  it('AC-28: 429 Retry-After: 0 on a create → retried, 201 (2 requests for that finding); published', async () => {
    const s = await setup();
    fake.when('POST', /\/draft_notes$/, { status: 429, headers: NOW });
    const pub = await publishAndSettle(s.reviewId, { finding_ids: [s.ids.multi!, s.ids.single!] });
    expect(pub.status).toBe('published');
    expect(createsFor(s.fullPath, s.ids.multi!)).toHaveLength(2);
    expect(createsFor(s.fullPath, s.ids.single!)).toHaveLength(1);
  });

  it('AC-28: a persistent 429 → rollback, failed gitlab_rate_limited; no bulk_publish, 0 drafts left, nothing published', async () => {
    const s = await setup();
    // The 1st create lands; the 2nd answers 429 forever.
    fake.when('POST', /\/draft_notes$/, { status: 429, headers: NOW }, 100, { skip: 1 });
    const pub = await publishAndSettle(s.reviewId, { finding_ids: s.ordered });
    expect(pub).toMatchObject({ status: 'failed', code: 'gitlab_rate_limited', published: 0 });
    // 1 + (1 try + GITLAB_MAX_RETRIES) attempts; nothing after the stop.
    expect(creates(s.fullPath)).toHaveLength(5);
    expect(bulks(s.fullPath)).toEqual([]);
    expect(fake.markerCount(s.fullPath, PUB_IID, 'all')).toBe(0);
    expect(pub.items.every((i) => i.state === 'rolled_back')).toBe(true);
  });

  it('AC-29: one finding rejected with 422 → that finding failed gitlab_position_rejected, the rest published (partially_published)', async () => {
    const s = await setup();
    // 2nd create (the single-line finding) is rejected definitively.
    fake.when('POST', /\/draft_notes$/, { status: 422, body: { message: 'note is invalid' } }, 1, { skip: 1 });
    const pub = await publishAndSettle(s.reviewId, { finding_ids: s.ordered });
    expect(pub).toMatchObject({ status: 'partially_published', published: 3, failed: 1 });
    const single = pub.items.find((i) => i.finding_id === s.ids.single)!;
    expect(single).toMatchObject({ state: 'failed', code: 'gitlab_position_rejected', link: null });
    expect(createsFor(s.fullPath, s.ids.single!)).toHaveLength(1); // a 422 is not re-sent
    expect(bulks(s.fullPath)).toHaveLength(1);
    expect(fake.markerCount(s.fullPath, PUB_IID, 'notes')).toBe(3);
  });

  it('AC-29: every finding rejected → no bulk_publish (human drafts stay drafts), failed gitlab_position_rejected', async () => {
    const s = await setup();
    const human = fake.addHumanDraft(s.fullPath, PUB_IID, SERVICE_ACCOUNT, 'A human draft');
    fake.when('POST', /\/draft_notes$/, { status: 422 }, 10);
    const pub = await publishAndSettle(s.reviewId, { finding_ids: s.ordered });
    expect(pub).toMatchObject({ status: 'failed', code: 'gitlab_position_rejected', published: 0, failed: 4 });
    expect(bulks(s.fullPath)).toEqual([]);
    expect(fake.drafts(s.fullPath, PUB_IID)).toEqual([human]);
    expect(fake.notes(s.fullPath, PUB_IID)).toEqual([]);
  });

  it('AC-30: 502 on the 3rd create with the draft actually stored → no re-send, every draft of THIS publication deleted (incl. the landed one), others untouched, failed', async () => {
    const s = await setup();
    const human = fake.addHumanDraft(s.fullPath, PUB_IID, SERVICE_ACCOUNT, 'A human draft');
    fake.when('POST', /\/draft_notes$/, { status: 502, applyFirst: true }, 1, { skip: 2 });
    const pub = await publishAndSettle(s.reviewId, { finding_ids: s.ordered });
    expect(pub).toMatchObject({ status: 'failed', code: 'gitlab_publish_failed', published: 0 });
    expect(creates(s.fullPath)).toHaveLength(3); // stopped at the 3rd; never re-sent
    expect(fake.deletes).toHaveLength(3); // 2 confirmed + the unconfirmed one that landed
    expect(bulks(s.fullPath)).toEqual([]);
    expect(fake.drafts(s.fullPath, PUB_IID)).toEqual([human]);
    expect(fake.notes(s.fullPath, PUB_IID)).toEqual([]);
    expect(pub.items.every((i) => i.state === 'rolled_back')).toBe(true);
  });

  it('AC-31: rollback cannot delete a marked draft → failed gitlab_drafts_left_behind; the next publish removes it first', async () => {
    const s = await setup();
    fake.when('POST', /\/draft_notes$/, { status: 502 }, 1, { skip: 1 }); // 2nd create fails (not landed)
    fake.when('DELETE', /\/draft_notes\/\d+$/, { status: 500, headers: NOW }, 4); // 1 try + 3 retries
    const first = await publishAndSettle(s.reviewId, { finding_ids: s.ordered });
    expect(first).toMatchObject({ status: 'failed', code: 'gitlab_drafts_left_behind', published: 0 });
    expect(first.message).toMatch(/draft notes remain/);
    const left = [...fake.drafts(s.fullPath, PUB_IID)];
    expect(left).toHaveLength(1);
    expect(left[0]!.note).toContain(`p=${first.id}`);

    fake.reset();
    const second = await publishAndSettle(s.reviewId, { finding_ids: s.ordered });
    expect(second).toMatchObject({ status: 'published', published: 4 });
    const firstDelete = fake.deletes[0]!;
    expect(firstDelete.path).toBe(`${mrApiPath(s.fullPath)}/draft_notes/${left[0]!.id}`);
    expect(fake.requests.indexOf(firstDelete)).toBeLessThan(fake.requests.indexOf(creates(s.fullPath)[0]!));
    expect(fake.markerCount(s.fullPath, PUB_IID, 'drafts')).toBe(0);
    expect(fake.markerCount(s.fullPath, PUB_IID, 'notes', { publicationId: first.id })).toBe(0);
    expectAtMostOneNotePerFinding(s.fullPath, s.ordered);
  });

  it('AC-32: bulk_publish publishes then answers 504 → no re-send; reconciled by reading → published with links', async () => {
    const s = await setup();
    fake.when('POST', /\/bulk_publish$/, { status: 504, applyFirst: true });
    const pub = await publishAndSettle(s.reviewId, { finding_ids: s.ordered });
    expect(pub).toMatchObject({ status: 'published', published: 4 });
    expect(bulks(s.fullPath)).toHaveLength(1);
    expect(pub.items.every((i) => i.state === 'published' && i.link?.url)).toBe(true);
    expectAtMostOneNotePerFinding(s.fullPath, s.ordered);
  });

  it('AC-32: bulk_publish 504 that did NOT land → own drafts deleted, other drafts untouched, failed gitlab_publish_unconfirmed', async () => {
    const s = await setup();
    const human = fake.addHumanDraft(s.fullPath, PUB_IID, SERVICE_ACCOUNT, 'A human draft');
    fake.when('POST', /\/bulk_publish$/, { status: 504 });
    const pub = await publishAndSettle(s.reviewId, { finding_ids: s.ordered });
    expect(pub).toMatchObject({ status: 'failed', code: 'gitlab_publish_unconfirmed', published: 0 });
    expect(bulks(s.fullPath)).toHaveLength(1);
    expect(fake.drafts(s.fullPath, PUB_IID)).toEqual([human]);
    expect(fake.notes(s.fullPath, PUB_IID)).toEqual([]);
    expect(pub.items.every((i) => i.state === 'rolled_back')).toBe(true);
  });

  it('AC-33: bulk_publish unconfirmed AND the reads fail → unconfirmed with the exact message; findings non-selectable (publish_unconfirmed)', async () => {
    const s = await setup();
    fake.when('POST', /\/bulk_publish$/, { status: 504 });
    fake.when('GET', /\/discussions$/, { status: 500, headers: NOW }, 1_000);
    const pub = await publishAndSettle(s.reviewId, { finding_ids: [s.ids.multi!, s.ids.single!] });
    expect(pub).toMatchObject({ status: 'unconfirmed', code: 'gitlab_publish_unconfirmed', message: UNCONFIRMED });
    expect(pub.finished_at).toBeNull();

    const res = await app.inject({ method: 'GET', url: `/reviews/${s.reviewId}/publish-preview` });
    const preview = res.json() as PublishPreview;
    for (const id of [s.ids.multi!, s.ids.single!]) {
      expect(preview.findings.find((f) => f.finding_id === id)).toMatchObject({
        publishable: false,
        reason: 'publish_unconfirmed',
      });
    }
    expect(preview.findings.find((f) => f.finding_id === s.ids.offdiff)!.publishable).toBe(true);
    const blocked = await app.inject({
      method: 'POST',
      url: `/reviews/${s.reviewId}/publications`,
      payload: { finding_ids: [s.ids.multi!] },
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.code).toBe('finding_not_publishable');
    await settle(app); // the preview's reconcile attempt (reads still failing)
    expect((await getPublication(app, pub.id)).status).toBe('unconfirmed');
    expect(bulks(s.fullPath)).toHaveLength(1); // reconcile never re-sends bulk_publish
  });

  it('AC-30: a failed draft listing before any write → failed, and the findings are selectable again', async () => {
    const s = await setup();
    fake.when('GET', /\/draft_notes$/, { status: 500, headers: NOW }, 4); // 1 try + 3 read retries
    const pub = await publishAndSettle(s.reviewId, { finding_ids: [s.ids.single!] });
    expect(pub).toMatchObject({ status: 'failed', code: 'gitlab_publish_failed', published: 0 });
    expect(fake.writes).toEqual([]);
    expect(pub.items.every((i) => i.state === 'rolled_back')).toBe(true);
    fake.reset();
    const retry = await publishAndSettle(s.reviewId, { finding_ids: [s.ids.single!] });
    expect(retry.status).toBe('published');
  });

  it('AC-35: retrying after every failure path never yields a second note (or draft) for a finding', async () => {
    const s = await setup();
    const scenarios: (() => void)[] = [
      () => fake.when('POST', /\/draft_notes$/, { status: 429, headers: NOW }, 100, { skip: 1 }), // rate limited
      () => fake.when('POST', /\/draft_notes$/, { status: 502, applyFirst: true }, 1, { skip: 2 }), // create landed + 502
      () => fake.when('POST', /\/draft_notes$/, 'timeout', 1, { skip: 1 }), // create timeout
      () => fake.when('POST', /\/bulk_publish$/, { status: 504 }), // bulk did not land
      () => fake.when('POST', /\/draft_notes$/, { status: 422 }, 10), // all rejected
    ];
    for (const script of scenarios) {
      script();
      const pub = await publishAndSettle(s.reviewId, { finding_ids: s.ordered });
      expect(pub.status).toBe('failed');
      expect(fake.markerCount(s.fullPath, PUB_IID, 'all')).toBe(0);
      fake.reset();
    }
    const ok = await publishAndSettle(s.reviewId, { finding_ids: s.ordered });
    expect(ok).toMatchObject({ status: 'published', published: 4 });
    for (const f of s.ordered) {
      expect(fake.markerCount(s.fullPath, PUB_IID, 'notes', { findingId: f })).toBe(1);
    }
    expect(fake.markerCount(s.fullPath, PUB_IID, 'drafts')).toBe(0);

    // A published finding can never be drafted again.
    fake.reset();
    const again = await app.inject({
      method: 'POST',
      url: `/reviews/${s.reviewId}/publications`,
      payload: { finding_ids: s.ordered },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('finding_already_published');
    expect(fake.writes).toEqual([]);
  });

  // ---------- outdated-findings AC-27: the base failure paths with a DEPRECATED run ----------

  async function setupDeprecated() {
    seq += 1;
    const fullPath = `gl-fail-dep/team-${seq}/svc`;
    const seeded = await seedDeprecatedReview(pg.handle.db, fake, { workspaceId, fullPath, reason: 'head_moved' });
    const ordered = [seeded.ids.multi!, seeded.ids.single!, seeded.ids.withheld!, seeded.ids.offdiff!];
    return { ...seeded, fullPath, ordered };
  }
  const ack = (finding_ids: string[]) => ({ finding_ids, acknowledge_deprecated: true });

  it('outdated AC-27 + AC-30: deprecated run, a 400 fallback then a landed 502 → no re-send; every own draft (fallback included) deleted, others untouched', async () => {
    const s = await setupDeprecated();
    const human = fake.addHumanDraft(s.fullPath, PUB_IID, SERVICE_ACCOUNT, 'A human draft');
    // multi: 400 (multi-line) → 400 (single-line) → general fallback lands; single: 502 that landed.
    fake.when('POST', /\/draft_notes$/, { status: 400 }, 2);
    fake.when('POST', /\/draft_notes$/, { status: 502, applyFirst: true }, 1, { skip: 1 });
    const pub = await publishAndSettle(s.reviewId, ack(s.ordered));
    expect(pub).toMatchObject({ status: 'failed', code: 'gitlab_publish_failed', published: 0, deprecated: true });
    expect(createsFor(s.fullPath, s.ids.multi!)).toHaveLength(3);
    expect(createsFor(s.fullPath, s.ids.single!)).toHaveLength(1); // never re-sent after a 502
    // Every create (the general fallback included) carries the marker of its finding.
    for (const r of creates(s.fullPath)) expect((r.body as { note: string }).note).toMatch(/<!-- devdigest:publish:v1 /);
    expect(fake.deletes).toHaveLength(2); // the fallback draft + the landed one
    expect(bulks(s.fullPath)).toEqual([]);
    expect(fake.drafts(s.fullPath, PUB_IID)).toEqual([human]);
    expect(fake.notes(s.fullPath, PUB_IID)).toEqual([]);
    expect(pub.items.every((i) => i.state === 'rolled_back')).toBe(true);
  });

  it('outdated AC-27 + AC-32: deprecated run, bulk_publish lands then 504 → reconciled by marker, fallback included; never re-sent', async () => {
    const s = await setupDeprecated();
    fake.when('POST', /\/draft_notes$/, { status: 422 }, 1, { skip: 1 }); // single → general fallback
    fake.when('POST', /\/bulk_publish$/, { status: 504, applyFirst: true });
    const pub = await publishAndSettle(s.reviewId, ack(s.ordered));
    expect(pub).toMatchObject({ status: 'published', published: 4, deprecated: true, position_fallbacks: 1, general_notes: 3 });
    expect(bulks(s.fullPath)).toHaveLength(1);
    expect(pub.items.every((i) => i.state === 'published' && i.link?.url)).toBe(true);
    expectAtMostOneNotePerFinding(s.fullPath, s.ordered);
    expect(fake.markerCount(s.fullPath, PUB_IID, 'notes')).toBe(4);
  });

  it('outdated AC-27 + AC-23: deprecated run, a stale marked draft of an old publication is deleted first; no duplicate publish', async () => {
    const s = await setupDeprecated();
    fake.when('POST', /\/draft_notes$/, { status: 502 }, 1, { skip: 1 }); // 2nd create fails (not landed)
    fake.when('DELETE', /\/draft_notes\/\d+$/, { status: 500, headers: NOW }, 4); // the rollback cannot delete
    const first = await publishAndSettle(s.reviewId, ack(s.ordered));
    expect(first).toMatchObject({ status: 'failed', code: 'gitlab_drafts_left_behind', deprecated: true });
    const left = [...fake.drafts(s.fullPath, PUB_IID)];
    expect(left).toHaveLength(1);

    fake.reset();
    const second = await publishAndSettle(s.reviewId, ack(s.ordered));
    expect(second).toMatchObject({ status: 'published', published: 4, deprecated: true, reviewed_version_found: true });
    expect(fake.deletes[0]!.path).toBe(`${mrApiPath(s.fullPath)}/draft_notes/${left[0]!.id}`);
    expect(fake.requests.indexOf(fake.deletes[0]!)).toBeLessThan(fake.requests.indexOf(creates(s.fullPath)[0]!));
    expect(fake.markerCount(s.fullPath, PUB_IID, 'drafts')).toBe(0);
    expectAtMostOneNotePerFinding(s.fullPath, s.ordered);
  });
});
