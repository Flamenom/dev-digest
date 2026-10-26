import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PublicationWithDeprecation as Publication, PublishPreview } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockSecretsProvider } from '../src/adapters/mocks.js';
import { anonymous, asSession, asToken, buildGoogleApp, type GoogleTestApp, type SessionCredential } from './helpers/google-mode.js';
import { FakeGitLab, type FakeRequest } from './helpers/fake-gitlab.js';
import {
  PUB_IID,
  PUB_TOKEN,
  NEWER_SHA,
  REVIEWED_SHA,
  REVIEWED_VERSION_SHAS,
  addPublishMr,
  mrApiPath,
  newPublishFake,
  seedDeprecatedReview,
  seedPublishPr,
  settle,
  type FindingSeed,
} from './helpers/publish-fixtures.js';

/**
 * Plan T11 — google mode: the `review.publish` audit event and attribution of a
 * publish (spec 2026-10-21-gitlab-publish-findings AC-14 footer, AC-40, AC-41,
 * AC-42). Exactly one event per publication that reached a terminal status
 * after ≥ 1 GitLab write, strict count-only metadata, never a body, the summary
 * or a title; no `pr_comment.create` events; Member may publish; no session →
 * 401 with 0 GitLab requests.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;
if (!hasDocker) console.warn('[review-publish-audit] Docker not available — skipping.');

const MARKER_RE = /^<!-- devdigest:publish:v1 w=[0-9a-f-]{36} p=[0-9a-f-]{36} f=[0-9a-f-]{36} -->$/;
const FOOTER = '— posted by `Olena Dev` via DevDigest';
const SECRET_TEXT = {
  title: 'TITLE-MUST-NOT-REACH-THE-DB-scan',
  rationale: 'RATIONALE-MUST-NOT-REACH-THE-DB-scan',
  suggestion: 'SUGGESTION-MUST-NOT-REACH-THE-DB-scan',
  summary: 'SUMMARY-MUST-NOT-REACH-THE-DB-scan',
};

const FINDINGS: FindingSeed[] = [
  {
    key: 'multi',
    file: 'src/main.ts',
    startLine: 2,
    endLine: 4,
    severity: 'CRITICAL',
    title: SECRET_TEXT.title,
    rationale: SECRET_TEXT.rationale,
    suggestion: SECRET_TEXT.suggestion,
  },
  { key: 'single', file: 'src/main.ts', startLine: 5, endLine: 5, severity: 'WARNING', title: SECRET_TEXT.title },
  { key: 'withheld', file: 'src/huge.ts', startLine: 3, endLine: 3, severity: 'SUGGESTION', title: SECRET_TEXT.title },
];

d('review.publish audit + attribution (google mode, fake GitLab, Testcontainers pg)', () => {
  let pg: PgFixture;
  let app: GoogleTestApp;
  let fake: FakeGitLab;
  let member: SessionCredential;
  let memberId: string;
  let seq = 0;

  beforeAll(async () => {
    pg = await startPg();
    fake = newPublishFake();
    app = await buildGoogleApp({
      pg,
      overrides: {
        git: new MockGitClient(),
        secrets: new MockSecretsProvider({ GITLAB_TOKEN: PUB_TOKEN }),
        gitlabFetch: fake.fetch,
      },
    });
    const user = await app.createUser({ name: 'Olena Dev', role: 'member' });
    memberId = user.userId;
    member = await app.signIn(user);
  });
  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });
  beforeEach(() => fake.reset());

  async function setup() {
    seq += 1;
    const fullPath = `gl-audit-pub/team-${seq}/svc`;
    addPublishMr(fake, fullPath);
    const seeded = await seedPublishPr(app.db, { workspaceId: app.workspaceId, fullPath, findings: FINDINGS });
    return { ...seeded, fullPath, all: Object.values(seeded.ids) };
  }

  const publishAs = (cred: SessionCredential, reviewId: string, payload: Record<string, unknown>) =>
    app.app.inject(asSession(cred, { method: 'POST', url: `/reviews/${reviewId}/publications`, payload }));

  async function publishAndSettle(reviewId: string, payload: Record<string, unknown>): Promise<Publication> {
    const res = await publishAs(member, reviewId, payload);
    expect(res.statusCode, res.body).toBe(202);
    await settle(app.app);
    const read = await app.app.inject(asSession(member, { method: 'GET', url: `/publications/${(res.json() as Publication).id}` }));
    expect(read.statusCode).toBe(200);
    return read.json() as Publication;
  }

  const publishRows = () => app.db.select().from(t.auditEvents).where(eq(t.auditEvents.action, 'review.publish'));
  const creates = (fullPath: string) =>
    fake.matching(`${mrApiPath(fullPath)}/draft_notes`, 'POST').filter((r) => r.path.endsWith('/draft_notes'));
  const noteOf = (r: FakeRequest) => (r.body as { note: string }).note;

  it('AC-40 + AC-41: a Member publishes → 202; exactly ONE review.publish row with strict count-only metadata', async () => {
    const s = await setup();
    const pv = await app.app.inject(asSession(member, { method: 'GET', url: `/reviews/${s.reviewId}/publish-preview` }));
    expect((pv.json() as PublishPreview).viewer_can_publish).toBe(true);

    const before = (await publishRows()).length;
    const pub = await publishAndSettle(s.reviewId, { finding_ids: s.all, summary: SECRET_TEXT.summary });
    expect(pub).toMatchObject({ status: 'published', published: 3, created_by: { id: memberId, name: 'Olena Dev' } });

    const rows = (await publishRows()).filter((r) => (r.metadata as { publication_id?: string }).publication_id === pub.id);
    expect((await publishRows()).length).toBe(before + 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: app.workspaceId,
      actorUserId: memberId,
      action: 'review.publish',
      targetType: 'review',
      targetId: s.reviewId,
    });
    expect(rows[0]!.metadata).toEqual({
      provider: 'gitlab',
      publication_id: pub.id,
      pr_id: s.prId,
      outcome: 'published',
      requested: 3,
      published: 3,
      failed: 0,
      general_notes: 1,
      other_drafts_published: 0,
      applicable_suggestions: 0,
      has_summary: true,
      // Outdated-findings AC-26: always present, also for a non-deprecated run.
      deprecated: false,
      deprecation_reason: null,
      reviewed_version_found: null,
      position_fallbacks: 0,
    });
  });

  it('outdated-findings AC-26: a deprecated publish → one row with the 4 deprecation fields; audit_events holds no SHA and no body text', async () => {
    seq += 1;
    const fullPath = `gl-audit-pub/team-${seq}/svc`;
    const s = await seedDeprecatedReview(app.db, fake, {
      workspaceId: app.workspaceId,
      fullPath,
      reason: 'head_moved',
      findings: FINDINGS,
    });
    const all = Object.values(s.ids);
    // The position validator only accepts the reviewed version's SHAs (AC-7).
    fake.acceptPositionsOnly(fullPath, PUB_IID, REVIEWED_VERSION_SHAS);
    const pub = await publishAndSettle(s.reviewId, {
      finding_ids: all,
      summary: SECRET_TEXT.summary,
      acknowledge_deprecated: true,
    });
    expect(pub).toMatchObject({ status: 'published', published: 3, deprecated: true });

    const rows = (await publishRows()).filter((r) => (r.metadata as { publication_id?: string }).publication_id === pub.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toEqual({
      provider: 'gitlab',
      publication_id: pub.id,
      pr_id: s.prId,
      outcome: 'published',
      requested: 3,
      published: 3,
      failed: 0,
      general_notes: 1,
      other_drafts_published: 0,
      applicable_suggestions: 0,
      has_summary: true,
      deprecated: true,
      deprecation_reason: 'head_moved',
      reviewed_version_found: true,
      position_fallbacks: 0,
    });
    // The notes themselves do carry the deprecated line (sent to GitLab, never stored).
    const bodies = creates(fullPath).map(noteOf);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) expect(body).toContain(`reviewed at \`${REVIEWED_SHA.slice(0, 8)}\``);

    const audit = [...(await app.db.execute<{ row: string }>(sql.raw('select row_to_json(x)::text as row from audit_events x')))]
      .map((r) => r.row)
      .join('\n');
    for (const sha of [REVIEWED_SHA, REVIEWED_SHA.slice(0, 8), NEWER_SHA, NEWER_SHA.slice(0, 8), 'vbase-reviewed', 'vstart-reviewed']) {
      expect(audit).not.toContain(sha);
    }
    expect(audit).not.toContain('Deprecated');
    expect(audit).not.toContain('MUST-NOT-REACH');
  });

  it('AC-14 + AC-42: google mode — every note ends with the footer, the marker sits right before it; the summary carries the footer', async () => {
    const s = await setup();
    await publishAndSettle(s.reviewId, { finding_ids: s.all, summary: 'Overall fine.' });
    const bodies = creates(s.fullPath).map(noteOf);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      const lines = body.split('\n');
      expect(lines.at(-1)).toBe(FOOTER);
      expect(lines.at(-2)).toBe('');
      expect(lines.at(-3)).toMatch(MARKER_RE);
    }
    const bulk = fake.matching(/\/bulk_publish$/, 'POST')[0]!;
    expect((bulk.body as { note: string }).note).toBe(`Overall fine.\n\n${FOOTER}`);
  });

  it('AC-41: a partial publish → one row with outcome partially_published and the failed count', async () => {
    const s = await setup();
    fake.when('POST', /\/draft_notes$/, { status: 422 }, 1, { skip: 1 });
    const pub = await publishAndSettle(s.reviewId, { finding_ids: s.all });
    expect(pub.status).toBe('partially_published');
    const rows = (await publishRows()).filter((r) => (r.metadata as { publication_id?: string }).publication_id === pub.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ outcome: 'partially_published', requested: 3, published: 2, failed: 1 });
  });

  it('AC-41: a publish failing before any write → 0 rows; a validation 409 → 0 rows', async () => {
    const s = await setup();
    // The very first draft listing fails: nothing was written to GitLab.
    fake.when('GET', /\/draft_notes$/, { status: 500, headers: { 'retry-after': '0' } }, 4);
    const before = (await publishRows()).length;
    const failed = await publishAndSettle(s.reviewId, { finding_ids: [s.ids.single!] });
    expect(failed).toMatchObject({ status: 'failed', code: 'gitlab_publish_failed' });
    expect(fake.writes).toEqual([]);
    expect((await publishRows()).length).toBe(before);

    // (A different finding: see the `it.fails` bug test in review-publish-failures.it.test.ts —
    // after a draft-list failure the selected findings stay blocked.)
    fake.reset();
    await publishAndSettle(s.reviewId, { finding_ids: [s.ids.multi!] });
    const afterOk = (await publishRows()).length;
    const conflict = await publishAs(member, s.reviewId, { finding_ids: [s.ids.multi!] });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('finding_already_published');
    await settle(app.app);
    expect((await publishRows()).length).toBe(afterOk);
  });

  it('AC-41: no pr_comment.create rows; a DB scan of audit_events and review_publications* finds no body, summary or title text', async () => {
    const comments = await app.db.select().from(t.auditEvents).where(eq(t.auditEvents.action, 'pr_comment.create'));
    expect(comments).toEqual([]);
    const dump = async (table: string) =>
      [...(await app.db.execute<{ row: string }>(sql.raw(`select row_to_json(x)::text as row from ${table} x`)))]
        .map((r) => r.row)
        .join('\n');
    const all = [await dump('audit_events'), await dump('review_publications'), await dump('review_publication_items')].join('\n');
    expect(all).toContain('review.publish');
    for (const text of Object.values(SECRET_TEXT)) expect(all).not.toContain(text);
    expect(all).not.toContain('MUST-NOT-REACH');
    expect(all).not.toContain(PUB_TOKEN);
  });

  it('AC-40: API tokens are allowed (Member token → 202)', async () => {
    const s = await setup();
    const token = await app.createToken({ userId: memberId });
    const res = await app.app.inject(
      asToken(token, { method: 'POST', url: `/reviews/${s.reviewId}/publications`, payload: { finding_ids: [s.ids.single!] } }),
    );
    expect(res.statusCode, res.body).toBe(202);
    await settle(app.app);
  });

  it('AC-40: no session → 401 on every publish route, with 0 GitLab requests', async () => {
    const s = await setup();
    fake.reset();
    const calls = [
      { method: 'POST' as const, url: `/reviews/${s.reviewId}/publications`, payload: { finding_ids: [s.ids.single!] } },
      { method: 'GET' as const, url: `/reviews/${s.reviewId}/publish-preview` },
      { method: 'GET' as const, url: `/reviews/${s.reviewId}/publish-other-drafts` },
      { method: 'GET' as const, url: `/reviews/${s.reviewId}/publish-plan?finding_ids=${s.ids.single!}` },
      { method: 'GET' as const, url: `/reviews/${s.reviewId}/publications` },
      { method: 'GET' as const, url: `/publications/${s.reviewId}` },
    ];
    for (const call of calls) {
      const res = await app.app.inject(anonymous(call));
      expect(res.statusCode, call.url).toBe(401);
    }
    await settle(app.app);
    expect(fake.requests).toEqual([]);
    const rows = await app.db.select().from(t.reviewPublications).where(eq(t.reviewPublications.reviewId, s.reviewId));
    expect(rows).toEqual([]);
    expect(fake.markerCount(s.fullPath, PUB_IID, 'all')).toBe(0);
  });
});
