import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { HostComment, Publication, PublishPreviewWithDeprecation as PublishPreview } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { FakeGitLab, quickActionMatches, rawCommandLines, type FakeRequest } from './helpers/fake-gitlab.js';
import {
  HOSTILE_TEXT,
  PUB_HEAD,
  PUB_IID,
  SERVICE_ACCOUNT,
  addPublishMr,
  buildLocalPublishApp,
  getPublication,
  mrApiPath,
  newPublishFake,
  seedPublishPr,
  settle,
  type FindingSeed,
} from './helpers/publish-fixtures.js';

/**
 * Plan T11 — publish findings to a GitLab MR end to end, LOCAL auth mode: real
 * routes → `PublishService` → `PublishRunner`/`PublishExecutor` → the real
 * `RestGitLabClient` over a fake gitlab.com (`gitlabFetch`), Postgres for the
 * review, findings and publications (spec 2026-10-21-gitlab-publish-findings
 * AC-1, AC-2, AC-12, AC-15, AC-16, AC-21, AC-23 – AC-26, AC-42, AC-43; latency NFR).
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;
if (!hasDocker) console.warn('[review-publish] Docker not available — skipping.');

const MARKER_RE = /^<!-- devdigest:publish:v1 w=[0-9a-f-]{36} p=[0-9a-f-]{36} f=[0-9a-f-]{36} -->$/m;
const SUMMARY = '/merge\nOverall: please look at the import path, @olena.dev — see #3.';
const PERF_STRICT = process.env.PERF_STRICT === '1';

/** Mention / reference / image triggers GitLab would act on (plan "Mention guard" test table). */
const TRIGGERS: [string, RegExp][] = [
  ['user mention', /(^|[^\w​])@[\w.-]+/],
  ['issue ref', /(^|[^\w​/])#\d+/],
  ['MR ref', /(^|[^\w​\\])!\d+/],
  ['label', /(^|[^\w​])~\w/],
  ['milestone', /(^|[^\w​])%\w/],
  ['cross-project ref', /[\w.-]+\/[\w.-]+[#!]\d+/],
  ['image', /(^|[^\\])!\[/],
  ['raw img', /(^|[^\\])<img/i],
];

/** Text outside inline code spans and fenced blocks. */
function outsideCode(body: string): string {
  return body
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
}

d('publish findings to GitLab (local mode, fake GitLab, Testcontainers pg)', () => {
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

  async function setup(opts: { findings?: readonly FindingSeed[]; mrHead?: string; reviews?: number } = {}) {
    seq += 1;
    const fullPath = `gl-pub/team-${seq}/svc`;
    const mr = addPublishMr(fake, fullPath, { headSha: opts.mrHead ?? PUB_HEAD });
    const seeded = await seedPublishPr(pg.handle.db, {
      workspaceId,
      fullPath,
      findings: opts.findings,
      reviews: opts.reviews,
    });
    return { ...seeded, fullPath, mr };
  }

  const publish = (reviewId: string, payload: unknown) =>
    app.inject({ method: 'POST', url: `/reviews/${reviewId}/publications`, payload: payload as object });
  const preview = async (reviewId: string) => {
    const res = await app.inject({ method: 'GET', url: `/reviews/${reviewId}/publish-preview` });
    expect(res.statusCode).toBe(200);
    return res.json() as PublishPreview;
  };
  const creates = (fullPath: string) =>
    fake.matching(`${mrApiPath(fullPath)}/draft_notes`, 'POST').filter((r) => r.path.endsWith('/draft_notes'));
  const bulks = (fullPath: string) => fake.matching(`${mrApiPath(fullPath)}/draft_notes/bulk_publish`, 'POST');
  const noteOf = (r: FakeRequest) => (r.body as { note: string }).note;

  it('AC-21 + AC-23 + AC-24 + AC-26: happy path — 202 in progress; stale own draft deleted, humans published by the ONE bulk; N creates with markers; links', async () => {
    const s = await setup();
    // AC-23: 2 drafts of the service account without our marker (a human using
    // the bot account, another tool) + 1 stale marked draft of an old publication.
    fake.addHumanDraft(s.fullPath, PUB_IID, SERVICE_ACCOUNT, 'Human draft one');
    fake.addHumanDraft(s.fullPath, PUB_IID, SERVICE_ACCOUNT, 'Human draft two');
    const stalePub = '11111111-2222-4333-8444-555555555555';
    const staleFinding = '66666666-7777-4888-8999-000000000000';
    const stale = fake.addHumanDraft(
      s.fullPath,
      PUB_IID,
      SERVICE_ACCOUNT,
      `old\n\n<!-- devdigest:publish:v1 w=${workspaceId} p=${stalePub} f=${staleFinding} -->`,
    );
    // Someone else's draft: never listed, never published (per-author store).
    fake.addHumanDraft(s.fullPath, PUB_IID, 'olena.dev', 'Olena private draft');

    const ids = [s.ids.multi!, s.ids.single!, s.ids.withheld!, s.ids.offdiff!];
    const res = await publish(s.reviewId, { finding_ids: ids, summary: SUMMARY });
    expect(res.statusCode).toBe(202);
    const accepted = res.json() as Publication;
    expect(accepted).toMatchObject({ status: 'in_progress', requested: 4, review_id: s.reviewId, pr_id: s.prId });
    expect(accepted.id).toMatch(/^[0-9a-f-]{36}$/);

    await settle(app);
    const done = await getPublication(app, accepted.id);
    expect(done).toMatchObject({
      status: 'published',
      code: null,
      requested: 4,
      drafted: 4,
      published: 4,
      failed: 0,
      general_notes: 2,
      other_drafts_published: 2,
      has_summary: true,
    });

    // AC-23: exactly one delete — the stale marked draft; humans untouched.
    expect(fake.deletes.map((r) => r.path)).toEqual([`${mrApiPath(s.fullPath)}/draft_notes/${stale.id}`]);
    // AC-25/AC-26: N creates, then exactly ONE bulk_publish with the summary.
    const sent = creates(s.fullPath);
    expect(sent).toHaveLength(4);
    expect(bulks(s.fullPath)).toHaveLength(1);
    const bulk = bulks(s.fullPath)[0]!;
    expect(fake.requests.indexOf(bulk)).toBeGreaterThan(fake.requests.indexOf(sent[3]!));
    expect(bulk.body).toEqual({ note: expect.stringContaining('Overall: please look at the import path') });
    expect(bulk.body).not.toHaveProperty('reviewer_state');
    expect(bulk.body).not.toHaveProperty('internal');
    // AC-24: every create carries the ids-only marker for its own finding.
    sent.forEach((r, i) => {
      expect(noteOf(r)).toMatch(MARKER_RE);
      expect(noteOf(r)).toContain(`p=${accepted.id} f=${ids[i]}`);
    });
    // AC-25 order: CRITICAL multi → WARNING single → SUGGESTION src/huge.ts → src/main.ts:40.
    expect((sent[0]!.body as { position: { line_range?: unknown } }).position.line_range).toBeDefined();
    expect(sent[1]!.body).toMatchObject({ position: { old_line: 3, new_line: 5, head_sha: PUB_HEAD } });
    expect(sent[2]!.body).not.toHaveProperty('position');
    expect(sent[3]!.body).not.toHaveProperty('position');

    // GitLab state: humans published with the batch; Olena's private draft untouched.
    expect(fake.drafts(s.fullPath, PUB_IID).map((x) => x.note)).toEqual(['Olena private draft']);
    const notes = fake.notes(s.fullPath, PUB_IID);
    expect(notes.map((n) => n.body)).toEqual(expect.arrayContaining(['Human draft one', 'Human draft two']));

    // AC-26: links for positioned AND general notes; the human notes are linked to nothing.
    const humanIds = new Set(notes.filter((n) => n.body.startsWith('Human draft')).map((n) => n.id));
    expect(done.items).toHaveLength(4);
    for (const item of done.items) {
      expect(item.state).toBe('published');
      expect(item.link).not.toBeNull();
      const note = notes.find((n) => n.id === item.link!.note_id)!;
      expect(note.body).toContain(`f=${item.finding_id}`);
      expect(humanIds.has(note.id)).toBe(false);
      expect(item.link!.url).toBe(`https://gitlab.com/${s.fullPath}/-/merge_requests/${PUB_IID}#note_${note.id}`);
      expect(item.link!.discussion_id).toBeTruthy();
    }
  });

  it('AC-25: progress (drafted counter) is readable while the batch is still running', async () => {
    const s = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Creates 1–2 pass; the 3rd create waits on the gate.
    fake.when('POST', /\/draft_notes$/, { passThrough: true, gate }, 1, { skip: 2 });
    const res = await publish(s.reviewId, { finding_ids: Object.values(s.ids) });
    expect(res.statusCode).toBe(202);
    const id = (res.json() as Publication).id;

    let mid: Publication | undefined;
    for (let i = 0; i < 200; i++) {
      mid = await getPublication(app, id);
      if (mid.drafted >= 2) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(mid).toMatchObject({ status: 'in_progress', drafted: 2, published: 0 });
    expect(mid!.items.filter((i) => i.state === 'drafted')).toHaveLength(2);
    release();
    await settle(app);
    expect(await getPublication(app, id)).toMatchObject({ status: 'published', drafted: 4, published: 4 });
  });

  it('AC-12 (superseded by outdated-findings AC-3/AC-4): MR head moved → 409 review_diff_outdated without the ack (1 MR read, 0 writes, 0 rows); 202 with the ack', async () => {
    const s = await setup({ mrHead: 'pushed9999' });
    const res = await publish(s.reviewId, { finding_ids: [s.ids.multi!] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('review_diff_outdated');
    expect(res.json().error.message).toBe('This review is outdated — confirm publishing its findings as deprecated.');
    expect(fake.matching(new RegExp(`${escapeRe(mrApiPath(s.fullPath))}$`), 'GET')).toHaveLength(1);
    expect(fake.writes).toEqual([]);
    expect(fake.deletes).toEqual([]);
    const rows = await pg.handle.db.select().from(t.reviewPublications).where(eq(t.reviewPublications.reviewId, s.reviewId));
    expect(rows).toEqual([]);

    // Acknowledged → accepted as a deprecated publication. No version on the fake MR
    // matches the review head → every finding general (outdated-findings AC-8).
    fake.reset();
    const acked = await publish(s.reviewId, { finding_ids: [s.ids.multi!], acknowledge_deprecated: true });
    expect(acked.statusCode, acked.body).toBe(202);
    await settle(app);
    const done = await getPublication(app, (acked.json() as Publication).id);
    expect(done).toMatchObject({
      status: 'published',
      published: 1,
      general_notes: 1,
      deprecated: true,
      deprecation_reason: 'head_moved',
      reviewed_version_found: false,
    });
    expect(creates(s.fullPath)[0]!.body).not.toHaveProperty('position');
  });

  it('AC-15 + AC-16: no quick action and no mention / reference / image trigger outside code in any body or the summary', async () => {
    const hostile: FindingSeed[] = [
      {
        key: 'h1',
        file: 'src/main.ts',
        startLine: 2,
        endLine: 2,
        severity: 'CRITICAL',
        title: '/close @all #12 !45',
        rationale: HOSTILE_TEXT,
        suggestion: 'Try this:\n/approve\n@group/sub please ~security %"v 1"\n```\n/close inside code @all\n```',
      },
      { key: 'h2', file: 'src/huge.ts', startLine: 1, endLine: 1, severity: 'WARNING', title: 'x', rationale: `>>>\n/merge\n>>>\n${HOSTILE_TEXT}` },
    ];
    const s = await setup({ findings: hostile });
    const res = await publish(s.reviewId, { finding_ids: [s.ids.h1!, s.ids.h2!], summary: SUMMARY });
    expect(res.statusCode).toBe(202);
    await settle(app);
    expect((await getPublication(app, (res.json() as Publication).id)).status).toBe('published');

    const bodies = creates(s.fullPath).map(noteOf);
    const summary = (bulks(s.fullPath)[0]!.body as { note: string }).note;
    expect(bodies).toHaveLength(2);
    for (const text of [...bodies, summary]) {
      expect(rawCommandLines(text), text).toEqual([]);
      expect(quickActionMatches(text), text).toEqual([]);
    }
    for (const body of bodies) {
      const prose = outsideCode(body);
      for (const [name, re] of TRIGGERS) expect(re.test(prose), `${name} in:\n${prose}`).toBe(false);
      // Same visible text: U+200B / the inserted backslashes removed ⇒ the hostile words are back.
      const visible = body.replace(/​/g, '').replace(/\\([!<])/g, '$1');
      expect(visible).toContain('@all see #12 and !45, ~bug %v1 and group/project#7.');
      // Code is untouched.
      expect(body).toContain('`@keep #1`');
    }
    // The summary keeps mentions / references (only quick actions are neutralised).
    expect(summary).toContain('@olena.dev');
    expect(summary).toContain('#3');
  });

  it('AC-42: local mode — every body ends with the marker (no footer), the summary has no footer, 0 audit rows', async () => {
    const s = await setup();
    const res = await publish(s.reviewId, { finding_ids: [s.ids.single!, s.ids.offdiff!], summary: 'Short summary.' });
    expect(res.statusCode).toBe(202);
    const id = (res.json() as Publication).id;
    await settle(app);
    for (const body of creates(s.fullPath).map(noteOf)) {
      const last = body.split('\n').at(-1)!;
      expect(last).toMatch(MARKER_RE);
      expect(body).not.toContain('via DevDigest');
    }
    expect((bulks(s.fullPath)[0]!.body as { note: string }).note).toBe('Short summary.');
    const audits = await pg.handle.db.select().from(t.auditEvents).where(eq(t.auditEvents.action, 'review.publish'));
    expect(audits).toEqual([]);
    expect((await getPublication(app, id)).status).toBe('published');
  });

  it('AC-43: GET /pulls/:id/comments after a publish → the positioned finding notes without the marker; general notes absent', async () => {
    const s = await setup();
    const res = await publish(s.reviewId, { finding_ids: Object.values(s.ids) });
    expect(res.statusCode).toBe(202);
    await settle(app);
    const read = await app.inject({ method: 'GET', url: `/pulls/${s.prId}/comments` });
    expect(read.statusCode).toBe(200);
    const comments = read.json() as HostComment[];
    // multi (anchored at its end line 4) + single (line 5); withheld + off-diff are general notes.
    expect(comments.map((c) => c.line).sort()).toEqual([4, 5]);
    for (const c of comments) {
      expect(c.user).toBe(SERVICE_ACCOUNT);
      expect(c.body).not.toContain('devdigest:publish');
      expect(c.body).not.toMatch(/<!--/);
      expect(c.body.length).toBeGreaterThan(0);
    }
  });

  it('AC-1 + AC-2: reviews expose head_sha (null for a pre-AC-1 row); the preview lists every finding with its anchor and makes 0 GitLab requests', async () => {
    const s = await setup();
    const [legacy] = await pg.handle.db
      .insert(t.reviews)
      .values({ workspaceId, prId: s.prId, kind: 'review', headSha: null })
      .returning();

    const reviews = await app.inject({ method: 'GET', url: `/pulls/${s.prId}/reviews` });
    expect(reviews.statusCode).toBe(200);
    const items = reviews.json() as { id: string; head_sha?: string | null }[];
    expect(items.find((r) => r.id === s.reviewId)?.head_sha).toBe(PUB_HEAD);
    expect(items.find((r) => r.id === legacy!.id)?.head_sha ?? null).toBeNull();

    fake.reset();
    const p = await preview(s.reviewId);
    expect(fake.requests).toEqual([]);
    expect(p).toMatchObject({ review_id: s.reviewId, provider: 'gitlab', mr_iid: PUB_IID, viewer_can_publish: true, blockers: [] });
    const byId = new Map(p.findings.map((f) => [f.finding_id, f]));
    expect(byId.get(s.ids.multi!)).toMatchObject({
      publishable: true,
      reason: null,
      anchor: { kind: 'multi_line', path: 'src/main.ts', start_line: 2, end_line: 4, off_diff_reason: null },
      suggestion_eligible: true,
      published: null,
    });
    expect(byId.get(s.ids.single!)!.anchor).toMatchObject({ kind: 'single_line', start_line: 5, end_line: 5 });
    expect(byId.get(s.ids.withheld!)!.anchor).toMatchObject({ kind: 'general', off_diff_reason: 'patch_unavailable' });
    expect(byId.get(s.ids.offdiff!)!.anchor).toMatchObject({ kind: 'general', off_diff_reason: 'not_on_diff_line' });

    expect(p.deprecation).toBeNull();

    // Outdated-findings AC-1 / AC-2 / AC-19: a legacy review is no longer blocked —
    // it reports `head_unknown` and every anchor is general `review_head_unknown`.
    const legacyPreview = await preview(legacy!.id);
    expect(legacyPreview.blockers).toEqual([]);
    expect(legacyPreview.deprecation).toEqual({ reason: 'head_unknown', reviewed_head_sha: null });
    expect(fake.requests).toEqual([]);

    // After a publish the preview carries the published link (who, when, URL).
    const res = await publish(s.reviewId, { finding_ids: [s.ids.single!] });
    expect(res.statusCode).toBe(202);
    await settle(app);
    fake.reset();
    const after = await preview(s.reviewId);
    expect(fake.requests).toEqual([]);
    const single = after.findings.find((f) => f.finding_id === s.ids.single)!;
    expect(single).toMatchObject({ publishable: false, reason: 'already_published' });
    expect(single.published?.url).toMatch(new RegExp(`^https://gitlab\\.com/${escapeRe(s.fullPath)}/-/merge_requests/5#note_\\d+$`));
    expect(single.published?.publication_id).toBe((res.json() as Publication).id);
    expect(single.published?.published_at).toBeTruthy();
  });

  it(`NFR latency${PERF_STRICT ? ' (PERF_STRICT)' : ' (loose)'}: 50 findings → 202 fast, terminal in budget; preview of 100 findings fast`, async () => {
    const perRequestMs = PERF_STRICT ? 300 : 20;
    const factor = PERF_STRICT ? 1 : 4;
    const many: FindingSeed[] = Array.from({ length: 100 }, (_, i) => ({
      key: `f${i}`,
      file: 'src/huge.ts',
      startLine: i + 1,
      endLine: i + 1,
      severity: 'SUGGESTION',
      title: `Finding ${i}`,
    }));
    const s = await setup({ findings: many });
    // Warm the token gate (one scope check) so the 202 path only reads the diff refs.
    const warm = await app.inject({ method: 'GET', url: `/reviews/${s.reviewId}/publish-other-drafts` });
    expect(warm.json()).toEqual({ other_drafts: 0 });

    const t0 = performance.now();
    await preview(s.reviewId);
    const previewMs = performance.now() - t0;
    expect(previewMs).toBeLessThan(500 * factor);

    fake.latencyMs = perRequestMs;
    const ids = s.findingIds[0]!.slice(0, 50);
    const t1 = performance.now();
    const res = await publish(s.reviewId, { finding_ids: ids });
    const acceptMs = performance.now() - t1;
    expect(res.statusCode).toBe(202);
    expect(acceptMs).toBeLessThan(1_000 * factor);
    await settle(app);
    const totalMs = performance.now() - t1;
    expect(totalMs).toBeLessThan(25_000 * factor);
    const done = await getPublication(app, (res.json() as Publication).id);
    expect(done).toMatchObject({ status: 'published', published: 50 });
    const rows = await pg.handle.db
      .select()
      .from(t.reviewPublicationItems)
      .where(inArray(t.reviewPublicationItems.findingId, ids));
    expect(rows.every((r) => r.state === 'published')).toBe(true);
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
