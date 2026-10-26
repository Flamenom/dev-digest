/**
 * Background publish algorithm (spec `specs/2026-10-21-gitlab-publish-findings.md`,
 * AC-13, AC-23 – AC-33, AC-41, AC-42; plan T8). Hermetic: an in-memory
 * `PublishStore` fake + the T3 `MockGitLabClient`. No Postgres (onion §10).
 */
import { describe, it, expect } from 'vitest';
import type { AuditEventInput, HostRepoRef, Severity } from '@devdigest/shared';
import { ReviewPublishAuditMetadataWithDeprecation } from '@devdigest/shared';
import { MockGitLabClient, type MockGitLabOptions } from '../src/adapters/mocks.js';
import { PublishExecutor, type PublishRunInput } from '../src/modules/publish/executor.js';
import { resolveAnchor } from '../src/modules/publish/anchor.js';
import { composeSummary } from '../src/modules/publish/note-body.js';
import { PUBLISH_UNCONFIRMED_MESSAGE } from '../src/modules/publish/codes.js';
import { buildMarker, parseMarker } from '../src/modules/_shared/publish-marker.js';
import type {
  FinishPublicationPatch,
  PersistedFileLike,
  PublicationRecord,
  PublishFindingRow,
  PublishStore,
} from '../src/modules/publish/ports.js';

// ---------- Fixtures ----------

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '99999999-9999-4999-8999-999999999999';
const PUB = '22222222-2222-4222-8222-222222222222';
const OLD_PUB = '33333333-3333-4333-8333-333333333333';
const REVIEW = '44444444-4444-4444-8444-444444444444';
const PR = '55555555-5555-4555-8555-555555555555';
const ACTOR = '66666666-6666-4666-8666-666666666666';
const fid = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BOT = 'devdigest-bot';
const IID = 5;
const WEB_URL = 'https://gitlab.com/acme/app';
const REF: HostRepoRef = { provider: 'gitlab', host: 'gitlab.com', fullName: 'acme/app', owner: 'acme', name: 'app' };
const REFS = { baseSha: 'base0000', startSha: 'start000', headSha: 'head0000' };

/** new-side: 1 ctx, 2..6 added, 7 ctx. */
const FILES: PersistedFileLike[] = [
  {
    path: 'src/a.ts',
    patch: '@@ -1,2 +1,7 @@\n ctx1\n+a\n+b\n+c\n+d\n+e\n ctx2',
    previousPath: null,
    patchOmitted: null,
    changeType: 'modified',
  },
];

function finding(n: number, over: Partial<PublishFindingRow> = {}): PublishFindingRow {
  return {
    id: fid(n),
    severity: 'WARNING',
    category: 'bug',
    title: `Title ${n}`,
    rationale: `Rationale ${n}`,
    suggestion: null,
    kind: 'finding',
    evidence: null,
    file: 'src/a.ts',
    start_line: n + 1,
    end_line: n + 1,
    dismissed_at: null,
    ...over,
  };
}

function record(findings: PublishFindingRow[], over: Partial<PublicationRecord> = {}): PublicationRecord {
  return {
    id: PUB,
    workspaceId: WS,
    reviewId: REVIEW,
    prId: PR,
    createdBy: { id: ACTOR, name: 'Ada' },
    status: 'in_progress',
    code: null,
    message: null,
    requested: findings.length,
    drafted: 0,
    published: 0,
    failed: 0,
    generalNotes: 0,
    applicableSuggestions: 0,
    otherDraftsPublished: 0,
    hasSummary: false,
    applySuggestions: false,
    diffHeadSha: null,
    deprecated: false,
    deprecationReason: null,
    reviewedVersionFound: null,
    positionFallbacks: 0,
    bulkPublishSentAt: null,
    createdAt: new Date('2026-10-21T00:00:00Z'),
    updatedAt: new Date('2026-10-21T00:00:00Z'),
    finishedAt: null,
    items: findings.map((f, i) => ({
      findingId: f.id,
      position: i,
      state: 'pending',
      code: null,
      anchorKind: resolveAnchor(f, FILES).kind,
      draftId: null,
      discussionId: null,
      noteId: null,
      url: null,
      publishedAt: null,
    })),
    ...over,
  };
}

/** In-memory PublishStore: only the operations the executor uses. */
class FakeStore implements PublishStore {
  pubs = new Map<string, PublicationRecord>();
  leftover: { publicationIds: string[]; findingIds: string[] }[] = [];
  finishes: { from: string[]; patch: FinishPublicationPatch; won: boolean }[] = [];
  onBulkSent: () => void = () => {};

  constructor(...records: PublicationRecord[]) {
    for (const r of records) this.pubs.set(r.id, r);
  }
  get(id = PUB): PublicationRecord {
    return this.pubs.get(id)!;
  }
  item(findingId: string, id = PUB) {
    return this.get(id).items.find((i) => i.findingId === findingId)!;
  }

  loadReviewContext = async () => null;
  findingStates = async () => [];
  inProgressForPr = async () => null;
  createPublication = async (): Promise<PublicationRecord> => {
    throw new Error('not used');
  };
  deletePublication = async () => {};
  setStartDecision = async () => {};
  setAnchorResolution = async () => {};
  markItemDrafted = async (p: string, f: string, draftId: number) => {
    const it = this.item(f, p);
    it.state = 'drafted';
    it.draftId = draftId;
    this.get(p).drafted += 1;
  };
  markItemFailed = async (p: string, f: string, code: string) => {
    const it = this.item(f, p);
    it.state = 'failed';
    it.code = code;
  };
  markItemsPublished = async (p: string, links: readonly { findingId: string; discussionId: string | null; noteId: number | null; url: string | null; publishedAt: Date }[]) => {
    for (const l of links) {
      const it = this.item(l.findingId, p);
      Object.assign(it, { state: 'published', discussionId: l.discussionId, noteId: l.noteId, url: l.url, publishedAt: l.publishedAt });
    }
  };
  markItemsRolledBack = async (p: string, ids: readonly string[]) => {
    for (const f of ids) this.item(f, p).state = 'rolled_back';
  };
  rollBackLeftoverFindings = async (publicationIds: readonly string[], findingIds: readonly string[]) => {
    this.leftover.push({ publicationIds: [...publicationIds], findingIds: [...findingIds] });
  };
  setOtherDrafts = async (p: string, count: number) => {
    this.get(p).otherDraftsPublished = count;
  };
  setBulkPublishSent = async (p: string, at: Date) => {
    this.get(p).bulkPublishSentAt = at;
    this.onBulkSent();
  };
  touch = async () => {};
  finish = async (p: string, from: readonly string[], patch: FinishPublicationPatch) => {
    const r = this.pubs.get(p);
    const won = !!r && from.includes(r.status);
    this.finishes.push({ from: [...from], patch, won });
    if (!r || !won) return false;
    r.status = patch.status;
    r.code = patch.code;
    r.message = patch.message;
    r.finishedAt = patch.finishedAt;
    Object.assign(r, patch.counters ?? {});
    return true;
  };
  getPublication = async () => null;
  listForReview = async () => [];
  reconcileCandidates = async () => [];
  markOrphanedUnconfirmed = async () => 0;
}

function setup(opts: {
  findings: PublishFindingRow[];
  gitlab?: MockGitLabOptions;
  summary?: string | null;
  footerName?: string | null;
  audit?: 'google' | 'local';
}) {
  const host = new MockGitLabClient(opts.gitlab ?? {});
  const store = new FakeStore(record(opts.findings, { hasSummary: opts.summary != null }));
  const events: AuditEventInput[] = [];
  const logs: unknown[] = [];
  const log = { warn: (o: unknown) => logs.push(o), error: (o: unknown) => logs.push(o) };
  const executor = new PublishExecutor({
    store,
    audit: opts.audit === 'local' ? null : { record: async (e) => void events.push(e) },
    clock: { now: () => new Date('2026-10-21T12:00:00Z') },
    log,
  });
  const input: PublishRunInput = {
    publicationId: PUB,
    workspaceId: WS,
    reviewId: REVIEW,
    prId: PR,
    actorUserId: ACTOR,
    repoRef: REF,
    iid: IID,
    webUrl: WEB_URL,
    refs: REFS,
    serviceAccount: BOT,
    host,
    items: opts.findings.map((f) => ({ finding: f, anchor: resolveAnchor(f, FILES) })),
    summary: opts.summary ?? null,
    applySuggestions: false,
    footerName: opts.footerName ?? null,
    budget: { remainingMs: 60_000 },
    deprecation: null,
    anchorSource: 'persisted',
    reviewHeadSha: REFS.headSha,
  };
  return { host, store, events, logs, run: () => executor.run(input) };
}

const creates = (h: MockGitLabClient) => h.draftWrites.filter((w) => w.kind === 'create_draft_note');
const bulks = (h: MockGitLabClient) => h.draftWrites.filter((w) => w.kind === 'bulk_publish');
const deletes = (h: MockGitLabClient) => h.draftWrites.filter((w) => w.kind === 'delete_draft_note');
const markedDraftsLeft = (h: MockGitLabClient) =>
  (h.opts.drafts?.[IID] ?? []).filter((d) => parseMarker(d.note)?.publicationId === PUB);
const createsFor = (h: MockGitLabClient, findingId: string) =>
  creates(h).filter((w) => w.kind === 'create_draft_note' && parseMarker(w.note)?.findingId === findingId);

// ---------- Tests ----------

describe('PublishExecutor — happy path (AC-23, AC-25, AC-26)', () => {
  it('cleans the stale marked draft, creates in severity order, bulk-publishes once and links every note', async () => {
    const findings = [
      finding(3, { severity: 'SUGGESTION', file: 'src/gone.ts', start_line: 10, end_line: 10 }), // general
      finding(2, { severity: 'WARNING' }), // single line 3
      finding(1, { severity: 'CRITICAL', start_line: 2, end_line: 4 }), // multi-line 2..4
    ];
    const staleMarker = buildMarker({ workspaceId: WS, publicationId: OLD_PUB, findingId: fid(4) });
    const otherWsMarker = buildMarker({ workspaceId: OTHER_WS, publicationId: OLD_PUB, findingId: fid(5) });
    const t = setup({
      findings,
      summary: 'Overall looks good, @team',
      footerName: 'Ada',
      gitlab: {
        drafts: {
          [IID]: [
            { id: 1, author: BOT, note: 'human draft written as the bot', position: null },
            { id: 2, author: BOT, note: `other workspace\n\n${otherWsMarker}`, position: null },
            { id: 3, author: BOT, note: `stale\n\n${staleMarker}`, position: null },
            { id: 4, author: 'alice', note: 'someone else entirely', position: null },
          ],
        },
      },
    });
    let bulkCallsWhenPersisted = -1;
    t.store.onBulkSent = () => {
      bulkCallsWhenPersisted = bulks(t.host).length;
    };

    await t.run();

    // AC-23: exactly one delete — the stale marked draft; humans untouched.
    expect(deletes(t.host)).toEqual([{ kind: 'delete_draft_note', iid: IID, draftId: 3, result: 'deleted' }]);
    expect(t.store.leftover).toEqual([{ publicationIds: [OLD_PUB], findingIds: [fid(4)] }]);
    // AC-25: CRITICAL, WARNING, SUGGESTION; positions from the refs; general unpositioned.
    const sent = creates(t.host);
    expect(sent.map((w) => w.kind === 'create_draft_note' && parseMarker(w.note)?.findingId)).toEqual([fid(1), fid(2), fid(3)]);
    const [multi, single, general] = sent as Extract<(typeof sent)[number], { kind: 'create_draft_note' }>[];
    expect(multi!.position).toMatchObject({ headSha: REFS.headSha, baseSha: REFS.baseSha, newLine: 4, lineRange: { start: { newLine: 2 }, end: { newLine: 4 } } });
    expect(single!.position).toMatchObject({ newLine: 3, oldLine: null });
    expect(single!.position).not.toHaveProperty('lineRange');
    expect(general!.position).toBeNull();
    // AC-26: one bulk with the composed summary; persisted before sending.
    expect(bulks(t.host)).toHaveLength(1);
    expect(bulks(t.host)[0]).toMatchObject({ note: composeSummary('Overall looks good, @team', 'Ada') });
    expect(bulkCallsWhenPersisted).toBe(0);
    // Links.
    const pub = t.store.get();
    expect(pub.status).toBe('published');
    for (const n of [1, 2, 3]) {
      const it = t.store.item(fid(n));
      expect(it.state).toBe('published');
      expect(it.url).toMatch(/^https:\/\/gitlab\.com\/acme\/app\/-\/merge_requests\/5#note_\d+$/);
      expect(it.url).toBe(`${WEB_URL}/-/merge_requests/5#note_${it.noteId}`);
      expect(it.discussionId).toBeTruthy();
    }
    expect(pub.otherDraftsPublished).toBe(2);
    expect(pub.generalNotes).toBe(1);
    expect(pub.published).toBe(3);
    // Human drafts published with the batch (by the mock), never deleted.
    expect((t.host.opts.mrNotes?.[IID] ?? []).some((n) => n.body === 'human draft written as the bot')).toBe(true);
    expect((t.host.opts.drafts?.[IID] ?? []).map((d) => d.id)).toEqual([4]);
    // AC-41: one audit event with counts only.
    expect(t.events).toHaveLength(1);
    const ev = t.events[0]!;
    expect(ev).toMatchObject({ workspaceId: WS, actorUserId: ACTOR, action: 'review.publish', targetType: 'review', targetId: REVIEW });
    expect(ReviewPublishAuditMetadataWithDeprecation.parse(ev.metadata)).toEqual({
      provider: 'gitlab',
      publication_id: PUB,
      pr_id: PR,
      outcome: 'published',
      requested: 3,
      published: 3,
      failed: 0,
      general_notes: 1,
      other_drafts_published: 2,
      applicable_suggestions: 0,
      has_summary: true,
      // Outdated-findings AC-26: always present; a non-deprecated persisted run.
      deprecated: false,
      deprecation_reason: null,
      reviewed_version_found: null,
      position_fallbacks: 0,
    });
    const meta = JSON.stringify(ev.metadata);
    // The strict toEqual above already proves no draft / note id is present.
    for (const forbidden of ['Overall looks good', 'Title 1', 'Rationale', 'devdigest:publish']) {
      expect(meta).not.toContain(forbidden);
    }
  });

  it('ignores a note by another author carrying a copied marker (AC-24)', async () => {
    const f = finding(1);
    const copied = buildMarker({ workspaceId: WS, publicationId: PUB, findingId: f.id });
    const t = setup({
      findings: [f],
      gitlab: { mrNotes: { [IID]: [{ id: 1, discussionId: 'forged', author: 'mallory', body: `x\n\n${copied}`, system: false }] } },
    });
    await t.run();
    const it = t.store.item(f.id);
    expect(it.state).toBe('published');
    expect(it.noteId).not.toBe(1);
    expect(it.discussionId).not.toBe('forged');
  });

  it('local mode (audit null) records no event (AC-42)', async () => {
    const t = setup({ findings: [finding(1)], audit: 'local' });
    await t.run();
    expect(t.store.get().status).toBe('published');
    expect(t.events).toHaveLength(0);
  });
});

describe('PublishExecutor — per-finding rejections (AC-13, AC-29)', () => {
  it('re-sends a multi-line draft once as single-line after a 400', async () => {
    const f = finding(1, { severity: 'CRITICAL', start_line: 2, end_line: 4 });
    const t = setup({
      findings: [f],
      gitlab: { writeScript: { create_draft_note: [{ failure: { kind: 'rejected', status: 400 } }] } },
    });
    await t.run();
    const sent = createsFor(t.host, f.id) as Extract<ReturnType<typeof creates>[number], { kind: 'create_draft_note' }>[];
    expect(sent).toHaveLength(2);
    expect(sent[0]!.position).toHaveProperty('lineRange');
    expect(sent[1]!.position).not.toHaveProperty('lineRange');
    expect(sent[1]!.position).toMatchObject({ newLine: 4 });
    expect(bulks(t.host)).toHaveLength(1);
    expect(t.store.item(f.id).state).toBe('published');
    expect(t.store.get().status).toBe('published');
  });

  it('a 422 on the 3rd of 5 fails that finding only → partially_published', async () => {
    const findings = [1, 2, 3, 4, 5].map((n) => finding(n));
    const t = setup({
      findings,
      gitlab: { writeScript: { create_draft_note: ['ok', 'ok', { failure: { kind: 'rejected', status: 422 } }] } },
    });
    await t.run();
    expect(creates(t.host)).toHaveLength(5);
    expect(bulks(t.host)).toHaveLength(1);
    expect(t.store.item(fid(3))).toMatchObject({ state: 'failed', code: 'gitlab_position_rejected' });
    expect((t.host.opts.mrNotes?.[IID] ?? []).length).toBe(4);
    const pub = t.store.get();
    expect(pub).toMatchObject({ status: 'partially_published', published: 4, failed: 1 });
    expect(t.events).toHaveLength(1);
    expect(t.events[0]!.metadata).toMatchObject({ outcome: 'partially_published', published: 4, failed: 1 });
  });

  it('a 422 on every finding → no bulk_publish, failed (human drafts never published alone)', async () => {
    const findings = [1, 2, 3, 4, 5].map((n) => finding(n));
    const rejected = { failure: { kind: 'rejected' as const, status: 422 } };
    const t = setup({
      findings,
      gitlab: {
        drafts: { [IID]: [{ id: 1, author: BOT, note: 'human', position: null }] },
        writeScript: { create_draft_note: [rejected, rejected, rejected, rejected, rejected] },
      },
    });
    await t.run();
    expect(bulks(t.host)).toHaveLength(0);
    expect(t.store.get()).toMatchObject({ status: 'failed', code: 'gitlab_position_rejected', failed: 5, published: 0 });
    expect(t.host.opts.drafts?.[IID]).toHaveLength(1);
    expect(t.events).toHaveLength(1);
    expect(t.events[0]!.metadata).toMatchObject({ outcome: 'failed', other_drafts_published: 0 });
  });
});

describe('PublishExecutor — stop + rollback (AC-28, AC-30, AC-31)', () => {
  it('an unconfirmed create that landed is never re-sent and is rolled back; humans untouched', async () => {
    const findings = [1, 2, 3, 4].map((n) => finding(n));
    const t = setup({
      findings,
      gitlab: {
        drafts: { [IID]: [{ id: 1, author: BOT, note: 'human draft', position: null }] },
        writeScript: { create_draft_note: ['ok', 'ok', { failure: { kind: 'unconfirmed' }, landed: true }] },
      },
    });
    await t.run();
    expect(createsFor(t.host, fid(3))).toHaveLength(1);
    expect(createsFor(t.host, fid(4))).toHaveLength(0);
    expect(markedDraftsLeft(t.host)).toHaveLength(0);
    expect(t.host.opts.drafts?.[IID]).toEqual([{ id: 1, author: BOT, note: 'human draft', position: null }]);
    expect(bulks(t.host)).toHaveLength(0);
    expect(deletes(t.host)).toHaveLength(3);
    expect(t.store.get()).toMatchObject({ status: 'failed', code: 'gitlab_publish_failed', published: 0 });
    for (const n of [1, 2, 3, 4]) expect(t.store.item(fid(n)).state).toBe('rolled_back');
    expect(t.events).toHaveLength(1);
    expect(t.events[0]!.metadata).toMatchObject({ outcome: 'failed', published: 0 });
  });

  it('rate_limited (budget exhausted) → rollback with gitlab_rate_limited', async () => {
    const findings = [1, 2, 3].map((n) => finding(n));
    const t = setup({
      findings,
      gitlab: { writeScript: { create_draft_note: ['ok', { failure: { kind: 'rate_limited' } }] } },
    });
    await t.run();
    expect(creates(t.host)).toHaveLength(2);
    expect(bulks(t.host)).toHaveLength(0);
    expect(markedDraftsLeft(t.host)).toHaveLength(0);
    expect(t.store.get()).toMatchObject({ status: 'failed', code: 'gitlab_rate_limited' });
  });

  it('maps token / project failures (AC-30)', async () => {
    const cases = [
      [{ kind: 'token_invalid' as const }, 'gitlab_token_invalid'],
      [{ kind: 'not_found' as const }, 'gitlab_project_inaccessible'],
      [{ kind: 'forbidden' as const }, 'gitlab_publish_failed'],
    ] as const;
    for (const [failure, code] of cases) {
      const t = setup({ findings: [finding(1)], gitlab: { writeScript: { create_draft_note: [{ failure }] } } });
      await t.run();
      expect(t.store.get()).toMatchObject({ status: 'failed', code });
      expect(bulks(t.host)).toHaveLength(0);
    }
  });

  it('a delete failing during rollback → gitlab_drafts_left_behind', async () => {
    const findings = [1, 2].map((n) => finding(n));
    const t = setup({
      findings,
      gitlab: {
        errors: { delete_draft_note: new Error('500') },
        writeScript: { create_draft_note: ['ok', { failure: { kind: 'rate_limited' } }] },
      },
    });
    await t.run();
    expect(t.store.get()).toMatchObject({ status: 'failed', code: 'gitlab_drafts_left_behind' });
    expect(t.store.get().message).toMatch(/remain on the service account/);
    expect(bulks(t.host)).toHaveLength(0);
  });
});

describe('PublishExecutor — bulk_publish unconfirmed (AC-32, AC-33)', () => {
  it('published-then-504 → reconciled to published, links stored, exactly one bulk', async () => {
    const findings = [1, 2].map((n) => finding(n));
    const t = setup({
      findings,
      gitlab: { writeScript: { bulk_publish: [{ failure: { kind: 'unconfirmed' }, landed: true }] } },
    });
    await t.run();
    expect(bulks(t.host)).toHaveLength(1);
    expect(t.store.get().status).toBe('published');
    for (const n of [1, 2]) expect(t.store.item(fid(n)).url).toMatch(/#note_\d+$/);
  });

  it('504 without publishing → marked drafts deleted, failed gitlab_publish_unconfirmed', async () => {
    const findings = [1, 2].map((n) => finding(n));
    const t = setup({
      findings,
      gitlab: {
        drafts: { [IID]: [{ id: 1, author: BOT, note: 'human', position: null }] },
        writeScript: { bulk_publish: [{ failure: { kind: 'unconfirmed' } }] },
      },
    });
    await t.run();
    expect(bulks(t.host)).toHaveLength(1);
    expect(markedDraftsLeft(t.host)).toHaveLength(0);
    expect(t.host.opts.drafts?.[IID]).toHaveLength(1);
    expect(t.store.get()).toMatchObject({ status: 'failed', code: 'gitlab_publish_unconfirmed' });
    for (const n of [1, 2]) expect(t.store.item(fid(n)).state).toBe('rolled_back');
  });

  it('reads failing too → unconfirmed with the AC-33 message, no audit', async () => {
    const t = setup({
      findings: [finding(1)],
      gitlab: {
        errors: { mr_notes: new Error('502') },
        writeScript: { bulk_publish: [{ failure: { kind: 'unconfirmed' } }] },
      },
    });
    await t.run();
    expect(t.store.get()).toMatchObject({
      status: 'unconfirmed',
      code: 'gitlab_publish_unconfirmed',
      message: PUBLISH_UNCONFIRMED_MESSAGE,
      finishedAt: null,
    });
    expect(t.store.item(fid(1)).state).toBe('drafted');
    expect(t.events).toHaveLength(0);
    expect(bulks(t.host)).toHaveLength(1);
  });
});

describe('PublishExecutor — read-back and audit edges', () => {
  it('a note hidden on read-back → published with a null link, no extra writes (AC-27)', async () => {
    const findings = [1, 2, 3].map((n) => finding(n));
    const t = setup({ findings });
    const orig = t.host.listMrNotes;
    t.host.listMrNotes = async (ref, iid) => (await orig(ref, iid)).filter((n) => parseMarker(n.body)?.findingId !== fid(2));
    await t.run();
    expect(t.store.item(fid(2))).toMatchObject({ state: 'published', url: null, noteId: null });
    expect(t.store.item(fid(1)).url).not.toBeNull();
    expect(creates(t.host)).toHaveLength(3);
    expect(bulks(t.host)).toHaveLength(1);
    expect(deletes(t.host)).toHaveLength(0);
    expect(t.store.get().status).toBe('published');
  });

  it('a draft-list failure before any write → failed, no audit (AC-41)', async () => {
    const t = setup({ findings: [finding(1)], gitlab: { errors: { draft_notes: new Error('502') } } });
    await t.run();
    expect(t.store.get()).toMatchObject({ status: 'failed', code: 'gitlab_publish_failed' });
    expect(creates(t.host)).toHaveLength(0);
    expect(t.events).toHaveLength(0);
  });

  it('finish is a CAS: a publication already settled elsewhere gets no second audit event', async () => {
    const t = setup({ findings: [finding(1)] });
    t.store.get().status = 'failed';
    await t.run();
    expect(t.store.finishes.at(-1)!.won).toBe(false);
    expect(t.events).toHaveLength(0);
  });

  it('never logs a body, the summary or a title', async () => {
    const t = setup({
      findings: [finding(1, { severity: 'CRITICAL' as Severity })],
      summary: 'SECRET SUMMARY',
      gitlab: { writeScript: { bulk_publish: [{ failure: { kind: 'unconfirmed' } }] } },
    });
    await t.run();
    const logged = JSON.stringify(t.logs);
    expect(logged).not.toContain('SECRET SUMMARY');
    expect(logged).not.toContain('Title 1');
    expect(logged).not.toContain('devdigest:publish');
  });
});
