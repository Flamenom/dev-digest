import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  PublicationWithDeprecation as Publication,
  PublishPlan,
  PublishPreviewWithDeprecation as PublishPreview,
} from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { seed } from '../src/db/seed.js';
import { DEPRECATED_LINE_HEAD_UNKNOWN, DEPRECATED_LOCATION_SUFFIX } from '../src/modules/publish/note-body.js';
import { FakeGitLab, type FakeRequest } from './helpers/fake-gitlab.js';
import {
  NEWER_SHA,
  PUB_IID,
  REVIEWED_SHA,
  REVIEWED_VERSION_SHAS,
  buildLocalPublishApp,
  getPublication,
  mrApiPath,
  newPublishFake,
  seedDeprecatedReview,
  settle,
  type FindingSeed,
  type SeedDeprecatedOptions,
} from './helpers/publish-fixtures.js';

/**
 * Plan T10 — publish findings from an OUTDATED review run, marked deprecated,
 * end to end over the fake gitlab.com (spec
 * 2026-10-23-gitlab-publish-outdated-findings AC-3 – AC-12, AC-14 – AC-17,
 * AC-21, AC-25, AC-27, AC-28; latency NFR). Local auth mode; the audit half
 * (AC-26) lives in `review-publish-audit.it.test.ts` (google mode).
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;
if (!hasDocker) console.warn('[review-publish-deprecated] Docker not available — skipping.');

const MARKER_RE = /^<!-- devdigest:publish:v1 w=[0-9a-f-]{36} p=[0-9a-f-]{36} f=[0-9a-f-]{36} -->$/m;
const MOVED_LINE = `⚠ Deprecated: reviewed at \`${REVIEWED_SHA.slice(0, 8)}\`; the MR has changed since.`;
const PERF_STRICT = process.env.PERF_STRICT === '1';

d('publish an outdated review as deprecated (local mode, fake GitLab, Testcontainers pg)', () => {
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
  beforeEach(() => {
    fake.reset();
    fake.latencyMs = 0;
  });

  async function setup(opts: Omit<SeedDeprecatedOptions, 'workspaceId' | 'fullPath'>) {
    seq += 1;
    const fullPath = `gl-dep/team-${seq}/svc`;
    const s = await seedDeprecatedReview(pg.handle.db, fake, { workspaceId, fullPath, ...opts });
    /** Send order (severity → file → line). */
    const ordered = [s.ids.multi!, s.ids.single!, s.ids.withheld!, s.ids.offdiff!];
    return { ...s, ordered };
  }

  const publish = (reviewId: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/reviews/${reviewId}/publications`, payload });
  async function publishAndSettle(reviewId: string, payload: Record<string, unknown>): Promise<Publication> {
    const res = await publish(reviewId, payload);
    expect(res.statusCode, res.body).toBe(202);
    await settle(app);
    return getPublication(app, (res.json() as Publication).id);
  }
  const preview = async (reviewId: string) => {
    const res = await app.inject({ method: 'GET', url: `/reviews/${reviewId}/publish-preview` });
    expect(res.statusCode).toBe(200);
    return res.json() as PublishPreview;
  };
  const plan = (reviewId: string, ids: readonly string[]) =>
    app.inject({ method: 'GET', url: `/reviews/${reviewId}/publish-plan?finding_ids=${ids.join(',')}` });

  const creates = (fullPath: string) =>
    fake.matching(`${mrApiPath(fullPath)}/draft_notes`, 'POST').filter((r) => r.path.endsWith('/draft_notes'));
  const createsFor = (fullPath: string, findingId: string) =>
    creates(fullPath).filter((r) => noteOf(r).includes(`f=${findingId}`));
  const bulks = (fullPath: string) => fake.matching(`${mrApiPath(fullPath)}/draft_notes/bulk_publish`, 'POST');
  const refsReads = (fullPath: string) => fake.matching(new RegExp(`${escapeRe(mrApiPath(fullPath))}$`), 'GET');
  const versionLists = (fullPath: string) => fake.matching(new RegExp(`${escapeRe(mrApiPath(fullPath))}/versions$`), 'GET');
  const versionReads = (fullPath: string) =>
    fake.matching(new RegExp(`${escapeRe(mrApiPath(fullPath))}/versions/\\d+$`), 'GET');
  const noteOf = (r: FakeRequest) => (r.body as { note: string }).note;
  const positionOf = (r: FakeRequest) => (r.body as { position?: Record<string, unknown> }).position;

  it('AC-6 + AC-7 + AC-14 + AC-16 + AC-17 + AC-25: head moved + matching version → positioned with the VERSION SHAs; the persisted (newer) diff is ignored', async () => {
    const s = await setup({ reason: 'head_moved' });
    // Only the reviewed version's SHAs are accepted (AC-7): live refs would be rejected.
    fake.acceptPositionsOnly(s.fullPath, PUB_IID, REVIEWED_VERSION_SHAS);

    // AC-1 / AC-16 / AC-19: preview from persisted state only.
    const p = await preview(s.reviewId);
    expect(fake.requests).toEqual([]);
    expect(p.blockers).toEqual([]);
    expect(p.deprecation).toEqual({ reason: 'head_moved', reviewed_head_sha: REVIEWED_SHA });
    for (const f of p.findings) {
      expect(f.anchor).toMatchObject({ kind: 'deferred', off_diff_reason: null });
      expect(f.suggestion_eligible).toBe(false);
      expect(f.publishable).toBe(true);
    }

    const pub = await publishAndSettle(s.reviewId, {
      finding_ids: s.ordered,
      summary: 'Overall summary.',
      apply_suggestions: true,
      acknowledge_deprecated: true,
    });
    expect(pub).toMatchObject({
      status: 'published',
      published: 4,
      failed: 0,
      general_notes: 2,
      deprecated: true,
      deprecation_reason: 'head_moved',
      reviewed_version_found: true,
      position_fallbacks: 0,
    });

    // One refs read (sync), one versions list, one diff read of the NEWEST matching version.
    expect(refsReads(s.fullPath)).toHaveLength(1);
    expect(versionLists(s.fullPath)).toHaveLength(1);
    expect(versionReads(s.fullPath).map((r) => r.path)).toEqual([`${mrApiPath(s.fullPath)}/versions/${s.reviewed!.id}`]);

    const sent = creates(s.fullPath);
    expect(sent).toHaveLength(4);
    const shas = { base_sha: 'vbase-reviewed', start_sha: 'vstart-reviewed', head_sha: REVIEWED_SHA };
    expect(positionOf(sent[0]!)).toMatchObject({ ...shas, new_path: 'src/main.ts', new_line: 4 });
    expect(positionOf(sent[0]!)!.line_range).toBeDefined();
    expect(positionOf(sent[1]!)).toMatchObject({ ...shas, old_line: 3, new_line: 5 });
    expect(positionOf(sent[2]!)).toBeUndefined();
    expect(positionOf(sent[3]!)).toBeUndefined();

    // AC-14: the deprecated line right after the header, on every note.
    for (const r of sent) {
      expect(noteOf(r).split('\n')[1]).toBe(MOVED_LINE);
      expect(noteOf(r)).toMatch(MARKER_RE);
      // AC-16: never an applicable suggestion, even with apply_suggestions.
      expect(noteOf(r)).not.toContain('```suggestion');
    }
    // AC-15: general notes carry the reason-specific location suffix.
    expect(noteOf(sent[2]!)).toContain(DEPRECATED_LOCATION_SUFFIX.patch_unavailable);
    expect(noteOf(sent[3]!)).toContain(DEPRECATED_LOCATION_SUFFIX.not_on_diff_line);
    // AC-17: the summary starts with the deprecated line and a blank line.
    expect((bulks(s.fullPath)[0]!.body as { note: string }).note).toBe(`${MOVED_LINE}\n\nOverall summary.`);

    // AC-24 / AC-25: links say "published as deprecated".
    for (const item of pub.items) expect(item.link).toMatchObject({ deprecated: true });
    const after = await preview(s.reviewId);
    for (const f of after.findings) expect(f.published).toMatchObject({ deprecated: true, publication_id: pub.id });
    await settle(app);
  });

  it('AC-6 + AC-5: stale persisted files with the head unchanged → NOT deprecated, version-anchored, bodies without the deprecated line', async () => {
    const s = await setup({ reason: null, staleFiles: true });
    fake.acceptPositionsOnly(s.fullPath, PUB_IID, REVIEWED_VERSION_SHAS);
    const p = await preview(s.reviewId);
    expect(p.deprecation).toBeNull();
    expect(p.findings.every((f) => f.anchor.kind === 'deferred')).toBe(true);

    // No acknowledgement needed (not deprecated).
    const pub = await publishAndSettle(s.reviewId, { finding_ids: s.ordered });
    expect(pub).toMatchObject({
      status: 'published',
      published: 4,
      general_notes: 2,
      deprecated: false,
      deprecation_reason: null,
      reviewed_version_found: true,
      position_fallbacks: 0,
    });
    const sent = creates(s.fullPath);
    expect(positionOf(sent[0]!)).toMatchObject({ base_sha: 'vbase-reviewed', head_sha: REVIEWED_SHA });
    expect(positionOf(sent[1]!)).toMatchObject({ base_sha: 'vbase-reviewed', new_line: 5 });
    for (const r of sent) expect(noteOf(r)).not.toContain('Deprecated');
    expect(noteOf(sent[3]!)).toContain('(not on a changed line of this MR)');
    for (const item of pub.items) expect(item.link).toMatchObject({ deprecated: false });
  });

  it('AC-13: a non-deprecated (stale-files) run keeps the base rule — a 422 fails the finding, no general re-send', async () => {
    const s = await setup({ reason: null, staleFiles: true });
    fake.when('POST', /\/draft_notes$/, { status: 422 });
    const pub = await publishAndSettle(s.reviewId, { finding_ids: [s.ids.single!, s.ids.offdiff!] });
    expect(pub).toMatchObject({ status: 'partially_published', published: 1, failed: 1, position_fallbacks: 0 });
    expect(createsFor(s.fullPath, s.ids.single!)).toHaveLength(1);
    expect(pub.items.find((i) => i.finding_id === s.ids.single)).toMatchObject({ state: 'failed', code: 'gitlab_position_rejected' });
  });

  it('AC-8: no matching version → every finding general reviewed_version_unavailable, reviewed_version_found false', async () => {
    const s = await setup({ reason: 'head_moved', withReviewedVersion: false });
    const pub = await publishAndSettle(s.reviewId, { finding_ids: s.ordered, acknowledge_deprecated: true });
    expect(pub).toMatchObject({
      status: 'published',
      published: 4,
      general_notes: 4,
      deprecated: true,
      reviewed_version_found: false,
    });
    expect(versionLists(s.fullPath)).toHaveLength(1);
    expect(versionReads(s.fullPath)).toEqual([]);
    for (const r of creates(s.fullPath)) {
      expect(positionOf(r)).toBeUndefined();
      expect(noteOf(r)).toContain(DEPRECATED_LOCATION_SUFFIX.reviewed_version_unavailable);
      expect(noteOf(r).split('\n')[1]).toBe(MOVED_LINE);
    }
  });

  it('AC-8: a transient version-diff failure (network) → all general, reviewed_version_found false', async () => {
    const s = await setup({ reason: 'head_moved' });
    fake.when('GET', /\/versions\/\d+$/, 'network');
    const pub = await publishAndSettle(s.reviewId, { finding_ids: [s.ids.multi!, s.ids.single!], acknowledge_deprecated: true });
    expect(pub).toMatchObject({ status: 'published', general_notes: 2, reviewed_version_found: false });
    expect(versionReads(s.fullPath)).toHaveLength(1); // network errors are not retried
  });

  it('AC-8: versions list 403 → failed with the mapped code before any write; the findings are selectable again', async () => {
    const s = await setup({ reason: 'head_moved' });
    fake.when('GET', /\/versions$/, { status: 403, body: { message: '403 Forbidden' } });
    const pub = await publishAndSettle(s.reviewId, { finding_ids: s.ordered, acknowledge_deprecated: true });
    expect(pub).toMatchObject({ status: 'failed', code: 'gitlab_project_inaccessible', published: 0, deprecated: true });
    expect(fake.writes).toEqual([]);
    expect(fake.deletes).toEqual([]);
    expect(fake.matching(/\/draft_notes$/, 'GET')).toEqual([]); // stopped before the draft listing
    expect(pub.items.every((i) => i.state === 'rolled_back')).toBe(true);
    const p = await preview(s.reviewId);
    for (const id of s.ordered) expect(p.findings.find((f) => f.finding_id === id)!.publishable).toBe(true);
    await settle(app);

    fake.reset();
    const retry = await publishAndSettle(s.reviewId, { finding_ids: s.ordered, acknowledge_deprecated: true });
    expect(retry).toMatchObject({ status: 'published', published: 4, reviewed_version_found: true });
  });

  it('AC-9 + AC-4: legacy review (head unknown) → 409 review_head_unknown without the ack; with it 0 version reads, all general', async () => {
    const s = await setup({ reason: 'head_unknown' });
    const p = await preview(s.reviewId);
    expect(p.deprecation).toEqual({ reason: 'head_unknown', reviewed_head_sha: null });
    for (const f of p.findings) expect(f.anchor).toMatchObject({ kind: 'general', off_diff_reason: 'review_head_unknown' });

    const refused = await publish(s.reviewId, { finding_ids: s.ordered });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({
      code: 'review_head_unknown',
      message: 'This review is outdated — confirm publishing its findings as deprecated.',
    });
    expect(refsReads(s.fullPath)).toHaveLength(1);
    expect(fake.writes).toEqual([]);

    fake.reset();
    const pub = await publishAndSettle(s.reviewId, { finding_ids: s.ordered, acknowledge_deprecated: true });
    expect(pub).toMatchObject({
      status: 'published',
      published: 4,
      general_notes: 4,
      deprecated: true,
      deprecation_reason: 'head_unknown',
      reviewed_version_found: null,
    });
    expect(versionLists(s.fullPath)).toEqual([]);
    expect(versionReads(s.fullPath)).toEqual([]);
    for (const r of creates(s.fullPath)) {
      expect(positionOf(r)).toBeUndefined();
      expect(noteOf(r).split('\n')[1]).toBe(DEPRECATED_LINE_HEAD_UNKNOWN);
      expect(noteOf(r)).toContain(DEPRECATED_LOCATION_SUFFIX.review_head_unknown);
    }
  });

  it('AC-12 + AC-25: a 400 on a deprecated positioned draft → single-line re-send, then ONE general re-send (same marker); position_fallbacks 1', async () => {
    const s = await setup({ reason: 'head_moved' });
    // The multi-line create and its single-line re-send are both rejected.
    fake.when('POST', /\/draft_notes$/, { status: 400, body: { message: '400 position is invalid' } }, 2);
    const pub = await publishAndSettle(s.reviewId, {
      finding_ids: [s.ids.multi!, s.ids.single!],
      acknowledge_deprecated: true,
    });
    expect(pub).toMatchObject({ status: 'published', published: 2, failed: 0, general_notes: 1, position_fallbacks: 1 });

    const multi = createsFor(s.fullPath, s.ids.multi!);
    expect(multi).toHaveLength(3);
    expect(positionOf(multi[0]!)!.line_range).toBeDefined();
    expect(positionOf(multi[1]!)).not.toHaveProperty('line_range');
    expect(positionOf(multi[2]!)).toBeUndefined();
    expect(noteOf(multi[2]!)).toContain(DEPRECATED_LOCATION_SUFFIX.position_rejected);
    expect(noteOf(multi[2]!).split('\n')[1]).toBe(MOVED_LINE);
    // AC-27: the fallback draft carries the marker of the same finding.
    const marker = MARKER_RE.exec(noteOf(multi[0]!))![0];
    expect(noteOf(multi[2]!)).toContain(marker);
    expect(fake.markerCount(s.fullPath, PUB_IID, 'notes', { findingId: s.ids.multi! })).toBe(1);
  });

  it('AC-12: a 422 on a deprecated single-line draft → general re-send; a THIRD rejection fails the finding (max 3 creates)', async () => {
    const s = await setup({ reason: 'head_moved' });
    // single: 422 → general re-send OK. multi: 400 multi, 400 single-line, 400 general → failed.
    fake.when('POST', /\/draft_notes$/, { status: 400 }, 3);
    fake.when('POST', /\/draft_notes$/, { status: 422 }, 1);
    const pub = await publishAndSettle(s.reviewId, {
      finding_ids: [s.ids.multi!, s.ids.single!],
      acknowledge_deprecated: true,
    });
    expect(pub).toMatchObject({ status: 'partially_published', published: 1, failed: 1, position_fallbacks: 1 });
    expect(createsFor(s.fullPath, s.ids.multi!)).toHaveLength(3);
    expect(pub.items.find((i) => i.finding_id === s.ids.multi)).toMatchObject({ state: 'failed', code: 'gitlab_position_rejected' });
    const single = createsFor(s.fullPath, s.ids.single!);
    expect(single).toHaveLength(2);
    expect(positionOf(single[1]!)).toBeUndefined();
  });

  it('AC-11 + AC-28: the version lookup runs after the 202; moving the head mid-run triggers no further refs / version reads', async () => {
    const s = await setup({ reason: 'head_moved' });
    fake.acceptPositionsOnly(s.fullPath, PUB_IID, REVIEWED_VERSION_SHAS);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fake.when('GET', /\/versions$/, { passThrough: true, gate });

    const res = await publish(s.reviewId, { finding_ids: s.ordered, acknowledge_deprecated: true });
    expect(res.statusCode).toBe(202);
    // The 202 arrived while the versions list is still held at the gate (AC-11).
    expect(refsReads(s.fullPath)).toHaveLength(1);
    // Moving back to the reviewed head would flip the deprecation if it were re-read.
    fake.setHead(s.fullPath, PUB_IID, REVIEWED_SHA);
    release();
    await settle(app);

    const pub = await getPublication(app, (res.json() as Publication).id);
    expect(pub).toMatchObject({ status: 'published', deprecated: true, deprecation_reason: 'head_moved', reviewed_version_found: true });
    expect(refsReads(s.fullPath)).toHaveLength(1);
    expect(versionLists(s.fullPath)).toHaveLength(1);
    expect(versionReads(s.fullPath)).toHaveLength(1);
    for (const r of creates(s.fullPath)) expect(noteOf(r).split('\n')[1]).toBe(MOVED_LINE);
    await settle(app);
  });

  it('AC-21: the publish plan makes only GETs, reports the live deprecation, and its counts match the real placement', async () => {
    const s = await setup({ reason: 'head_moved' });
    const bad = await plan(s.reviewId, ['not-a-uuid']);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('publish_selection_invalid');

    fake.reset();
    const res = await plan(s.reviewId, s.ordered);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as PublishPlan;
    expect(body).toEqual({
      other_drafts: 0,
      plan_available: true,
      deprecation: { reason: 'head_moved', reviewed_head_sha: REVIEWED_SHA, live_head_sha: NEWER_SHA },
      placement: { positioned: 2, general: 2 },
    });
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.requests.every((r) => r.method === 'GET')).toBe(true);
    expect(fake.writes).toEqual([]);
    expect(fake.deletes).toEqual([]);

    const pub = await publishAndSettle(s.reviewId, { finding_ids: s.ordered, acknowledge_deprecated: true });
    expect(pub.general_notes).toBe(body.placement!.general);
    expect(pub.published - pub.general_notes).toBe(body.placement!.positioned);

    // A fatal version read → the placement is unavailable (never a write).
    const s2 = await setup({ reason: 'head_moved' });
    fake.reset();
    fake.when('GET', /\/versions$/, { status: 404 });
    const failed = await plan(s2.reviewId, [s2.ids.single!]);
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({ plan_available: false, placement: null });
    expect(fake.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it(`NFR latency${PERF_STRICT ? ' (PERF_STRICT)' : ' (loose)'}: 3 version pages → 202 fast, plan in budget, 50-finding deprecated publication terminal in budget`, async () => {
    const perRequestMs = PERF_STRICT ? 300 : 20;
    const factor = PERF_STRICT ? 1 : 4;
    const many: FindingSeed[] = Array.from({ length: 50 }, (_, i) => ({
      key: `f${i}`,
      file: i % 2 === 0 ? 'src/main.ts' : 'src/huge.ts',
      startLine: i % 2 === 0 ? 2 + (i % 4) : i + 1,
      endLine: i % 2 === 0 ? 2 + (i % 4) : i + 1,
      severity: 'SUGGESTION',
      title: `Finding ${i}`,
    }));
    const s = await setup({ reason: 'head_moved', findings: many });
    // 250 newer versions with other heads: the reviewed one sits on page 3 (newest first, 100 per page).
    for (let i = 0; i < 250; i++) fake.addVersion(s.fullPath, PUB_IID, { headSha: `filler${i}` });
    const ids = s.findingIds[0]!;
    // Warm the token gate so the 202 path only reads the diff refs.
    const warm = await app.inject({ method: 'GET', url: `/reviews/${s.reviewId}/publish-other-drafts` });
    expect(warm.json()).toEqual({ other_drafts: 0 });

    fake.latencyMs = perRequestMs;
    const t0 = performance.now();
    const planned = await plan(s.reviewId, ids);
    const planMs = performance.now() - t0;
    expect(planned.statusCode).toBe(200);
    expect((planned.json() as PublishPlan).placement).toEqual({ positioned: 25, general: 25 });
    expect(planMs).toBeLessThan(3_000 * factor);
    expect(versionLists(s.fullPath)).toHaveLength(3);

    fake.reset();
    const t1 = performance.now();
    const res = await publish(s.reviewId, { finding_ids: ids, acknowledge_deprecated: true });
    const acceptMs = performance.now() - t1;
    expect(res.statusCode, res.body).toBe(202);
    expect(acceptMs).toBeLessThan(1_000 * factor);
    await settle(app);
    expect(performance.now() - t1).toBeLessThan(30_000 * factor);
    fake.latencyMs = 0;
    const done = await getPublication(app, (res.json() as Publication).id);
    expect(done).toMatchObject({ status: 'published', published: 50, general_notes: 25, reviewed_version_found: true });
    expect(versionLists(s.fullPath)).toHaveLength(3);
  }, 120_000);

  // LAST: a 401 marks the shared token invalid (token health), blocking every later publish of this app.
  it('AC-8: versions list 401 → failed gitlab_token_invalid before any write; items rolled back', async () => {
    const s = await setup({ reason: 'head_moved' });
    fake.when('GET', /\/versions$/, { status: 401, body: { message: '401 Unauthorized' } });
    const pub = await publishAndSettle(s.reviewId, { finding_ids: s.ordered, acknowledge_deprecated: true });
    expect(pub).toMatchObject({ status: 'failed', code: 'gitlab_token_invalid', published: 0, deprecated: true });
    expect(fake.writes).toEqual([]);
    expect(fake.deletes).toEqual([]);
    expect(pub.items.every((i) => i.state === 'rolled_back')).toBe(true);
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
