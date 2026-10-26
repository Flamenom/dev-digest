/**
 * Publication reconciliation (spec `specs/2026-10-21-gitlab-publish-findings.md`,
 * AC-24, AC-32 – AC-34, AC-41; plan T8). Hermetic: in-memory store + MockGitLabClient.
 */
import { describe, it, expect } from 'vitest';
import type { AuditEventInput, HostRepoRef, PublicationStatus } from '@devdigest/shared';
import { ReviewPublishAuditMetadataWithDeprecation } from '@devdigest/shared';
import { MockGitLabClient, type MockGitLabOptions } from '../src/adapters/mocks.js';
import { PublishReconciler } from '../src/modules/publish/reconciler.js';
import { PUBLISH_UNCONFIRMED_MESSAGE } from '../src/modules/publish/codes.js';
import { buildMarker } from '../src/modules/_shared/publish-marker.js';
import { ConfigError } from '../src/platform/errors.js';
import type {
  FinishPublicationPatch,
  PublicationItemRecord,
  PublicationRecord,
  PublishReviewContext,
  PublishStore,
} from '../src/modules/publish/ports.js';

const WS = '11111111-1111-4111-8111-111111111111';
const PUB = '22222222-2222-4222-8222-222222222222';
const REVIEW = '44444444-4444-4444-8444-444444444444';
const PR = '55555555-5555-4555-8555-555555555555';
const ACTOR = '66666666-6666-4666-8666-666666666666';
const fid = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BOT = 'devdigest-bot';
const IID = 5;
const REF: HostRepoRef = { provider: 'gitlab', host: 'gitlab.com', fullName: 'acme/app', owner: 'acme', name: 'app' };
const NOW = new Date('2026-10-21T12:00:00Z');
const marker = (n: number) => buildMarker({ workspaceId: WS, publicationId: PUB, findingId: fid(n) });

function item(n: number, state: PublicationItemRecord['state'], draftId: number | null = null): PublicationItemRecord {
  return {
    findingId: fid(n),
    position: n,
    state,
    code: null,
    anchorKind: n === 2 ? 'general' : 'single_line',
    draftId,
    discussionId: null,
    noteId: null,
    url: null,
    publishedAt: null,
  };
}

function record(status: PublicationStatus, items: PublicationItemRecord[], over: Partial<PublicationRecord> = {}): PublicationRecord {
  return {
    id: PUB,
    workspaceId: WS,
    reviewId: REVIEW,
    prId: PR,
    createdBy: { id: ACTOR, name: 'Ada' },
    status,
    code: null,
    message: null,
    requested: items.length,
    drafted: items.filter((i) => i.draftId != null).length,
    published: 0,
    failed: 0,
    generalNotes: 0,
    applicableSuggestions: 0,
    otherDraftsPublished: 1,
    hasSummary: true,
    applySuggestions: false,
    diffHeadSha: 'head0000',
    deprecated: false,
    deprecationReason: null,
    reviewedVersionFound: null,
    positionFallbacks: 0,
    bulkPublishSentAt: null,
    createdAt: new Date('2026-10-21T00:00:00Z'),
    updatedAt: new Date('2026-10-21T00:00:00Z'),
    finishedAt: null,
    items,
    ...over,
  };
}

const CTX: PublishReviewContext = {
  review: { id: REVIEW, workspaceId: WS, prId: PR, headSha: 'head0000' },
  pr: { id: PR, number: IID, status: 'open', headSha: 'head0000', detailHeadSha: 'head0000' },
  repo: { provider: 'gitlab', ref: REF, webUrl: 'https://gitlab.com/acme/app' },
  findings: [],
  files: [],
};

class FakeStore implements PublishStore {
  finishes: { from: string[]; patch: FinishPublicationPatch; won: boolean }[] = [];
  candidateCalls = 0;
  constructor(public rec: PublicationRecord) {}
  private it(f: string) {
    return this.rec.items.find((i) => i.findingId === f)!;
  }
  loadReviewContext = async () => CTX;
  findingStates = async () => [];
  inProgressForPr = async () => null;
  createPublication = async (): Promise<PublicationRecord> => {
    throw new Error('not used');
  };
  deletePublication = async () => {};
  setStartDecision = async () => {};
  setAnchorResolution = async () => {};
  markItemDrafted = async () => {
    throw new Error('reconciler must not draft');
  };
  markItemFailed = async () => {};
  markItemsPublished = async (_p: string, links: readonly { findingId: string; discussionId: string | null; noteId: number | null; url: string | null; publishedAt: Date }[]) => {
    for (const l of links) Object.assign(this.it(l.findingId), { state: 'published', discussionId: l.discussionId, noteId: l.noteId, url: l.url, publishedAt: l.publishedAt });
  };
  markItemsRolledBack = async (_p: string, ids: readonly string[]) => {
    for (const f of ids) this.it(f).state = 'rolled_back';
  };
  rollBackLeftoverFindings = async () => {};
  setOtherDrafts = async () => {};
  setBulkPublishSent = async () => {
    throw new Error('reconciler must not publish');
  };
  touch = async () => {};
  finish = async (_p: string, from: readonly string[], patch: FinishPublicationPatch) => {
    const won = from.includes(this.rec.status);
    this.finishes.push({ from: [...from], patch, won });
    if (!won) return false;
    Object.assign(this.rec, { status: patch.status, code: patch.code, message: patch.message, finishedAt: patch.finishedAt }, patch.counters ?? {});
    return true;
  };
  getPublication = async () => this.rec;
  listForReview = async () => [this.rec];
  reconcileCandidates = async () => {
    this.candidateCalls += 1;
    return this.rec.status === 'unconfirmed' || this.rec.status === 'in_progress' ? [this.rec] : [];
  };
  markOrphanedUnconfirmed = async () => 0;
}

function setup(rec: PublicationRecord, gitlab: MockGitLabOptions = {}, opts: { active?: boolean; resolveThrows?: boolean; audit?: boolean } = {}) {
  const host = new MockGitLabClient(gitlab);
  const store = new FakeStore(rec);
  const events: AuditEventInput[] = [];
  const reconciler = new PublishReconciler({
    store,
    accessFor: () => ({
      resolve: async () => {
        if (opts.resolveThrows) throw new ConfigError('hosts offline');
        return { host, serviceAccount: BOT };
      },
    }),
    runner: { isActive: () => opts.active ?? false },
    audit: opts.audit === false ? null : { record: async (e) => void events.push(e) },
    clock: { now: () => NOW },
    log: { warn: () => {}, error: () => {} },
  });
  return { host, store, events, reconciler };
}

const writeKinds = (h: MockGitLabClient) => h.calls.map((c) => c.kind).filter((k) => k === 'create_draft_note' || k === 'bulk_publish');

describe('PublishReconciler (AC-32 – AC-34)', () => {
  it('in_progress with a marked draft and no published note → draft deleted, failed', async () => {
    const t = setup(record('in_progress', [item(1, 'drafted', 7000), item(2, 'pending')]), {
      drafts: {
        [IID]: [
          { id: 7000, author: BOT, note: `body\n\n${marker(1)}`, position: null },
          { id: 1, author: BOT, note: 'human', position: null },
        ],
      },
    });
    await t.reconciler.trigger(PR);
    await t.reconciler.whenIdle();
    expect(t.host.opts.drafts?.[IID]).toEqual([{ id: 1, author: BOT, note: 'human', position: null }]);
    expect(t.store.rec).toMatchObject({ status: 'failed', code: 'gitlab_publish_failed', published: 0, otherDraftsPublished: 0 });
    expect(t.store.rec.items.map((i) => i.state)).toEqual(['rolled_back', 'rolled_back']);
    expect(writeKinds(t.host)).toEqual([]);
    // AC-41: a write had happened (drafted) → exactly one audit event, actor = created_by.
    expect(t.events).toHaveLength(1);
    expect(t.events[0]).toMatchObject({ action: 'review.publish', actorUserId: ACTOR, targetId: REVIEW });
    expect(t.events[0]!.metadata).toMatchObject({ outcome: 'failed', published: 0 });
  });

  it('unconfirmed with published marked notes → published, links stored, never re-publishes', async () => {
    const t = setup(
      record('unconfirmed', [item(1, 'drafted', 7000), item(2, 'drafted', 7001)], { bulkPublishSentAt: NOW }),
      {
        mrNotes: {
          [IID]: [
            { id: 501, discussionId: 'd1', author: BOT, body: `a\n\n${marker(1)}`, system: false },
            { id: 502, discussionId: 'd2', author: BOT, body: `b\n\n${marker(2)}`, system: false },
          ],
        },
      },
    );
    await t.reconciler.reconcileAll();
    expect(t.store.rec).toMatchObject({ status: 'published', published: 2, generalNotes: 1, otherDraftsPublished: 1 });
    expect(t.store.rec.items[0]).toMatchObject({ state: 'published', noteId: 501, url: 'https://gitlab.com/acme/app/-/merge_requests/5#note_501' });
    expect(writeKinds(t.host)).toEqual([]);
    expect(t.events).toHaveLength(1);
  });

  it('deprecated run: settles a general fallback by marker and audits the 4 deprecation fields, no SHA (outdated AC-26, AC-27)', async () => {
    const t = setup(
      record('unconfirmed', [item(1, 'drafted', 7000), item(2, 'drafted', 7001)], {
        bulkPublishSentAt: NOW,
        deprecated: true,
        deprecationReason: 'head_moved',
        reviewedVersionFound: true,
        positionFallbacks: 1,
        diffHeadSha: 'abcdef0123456789abcdef0123456789abcdef01',
      }),
      {
        mrNotes: {
          [IID]: [
            { id: 501, discussionId: 'd1', author: BOT, body: `a\n\n${marker(1)}`, system: false },
            { id: 502, discussionId: 'd2', author: BOT, body: `general fallback\n\n${marker(2)}`, system: false },
          ],
        },
      },
    );
    await t.reconciler.reconcileAll();
    expect(t.store.rec).toMatchObject({ status: 'published', published: 2, generalNotes: 1, positionFallbacks: 1 });
    expect(writeKinds(t.host)).toEqual([]);
    expect(t.events).toHaveLength(1);
    const meta = ReviewPublishAuditMetadataWithDeprecation.parse(t.events[0]!.metadata);
    expect(meta).toMatchObject({
      deprecated: true,
      deprecation_reason: 'head_moved',
      reviewed_version_found: true,
      position_fallbacks: 1,
      general_notes: 1,
    });
    expect(JSON.stringify(t.events[0]!.metadata)).not.toMatch(/abcdef01|head0000/);
  });

  it('ignores a copied marker on a note by another author (AC-24)', async () => {
    const t = setup(record('unconfirmed', [item(1, 'drafted', 7000)], { bulkPublishSentAt: NOW }), {
      mrNotes: { [IID]: [{ id: 501, discussionId: 'd1', author: 'mallory', body: `x\n\n${marker(1)}`, system: false }] },
    });
    await t.reconciler.reconcileAll();
    expect(t.store.rec).toMatchObject({ status: 'failed', code: 'gitlab_publish_unconfirmed', published: 0 });
    expect(t.store.rec.items[0]!.state).toBe('rolled_back');
  });

  it('skips a publication whose task is still active in this process', async () => {
    const t = setup(record('in_progress', [item(1, 'drafted', 7000)]), {}, { active: true });
    await t.reconciler.trigger(PR);
    await t.reconciler.whenIdle();
    expect(t.host.calls).toEqual([]);
    expect(t.store.rec.status).toBe('in_progress');
  });

  it('reads failing → in_progress becomes unconfirmed (AC-33 message, no audit); unconfirmed stays', async () => {
    const t = setup(record('in_progress', [item(1, 'drafted', 7000)]), { errors: { mr_notes: new Error('502') } });
    await t.reconciler.reconcileAll();
    expect(t.store.rec).toMatchObject({ status: 'unconfirmed', message: PUBLISH_UNCONFIRMED_MESSAGE, finishedAt: null });
    expect(t.events).toHaveLength(0);

    await t.reconciler.reconcileAll();
    expect(t.store.rec.status).toBe('unconfirmed');
    expect(t.store.finishes).toHaveLength(1);
  });

  it('GitLab unavailable (ConfigError) → the row is left as is', async () => {
    const t = setup(record('unconfirmed', [item(1, 'drafted', 7000)]), {}, { resolveThrows: true });
    await t.reconciler.reconcileAll();
    expect(t.store.rec.status).toBe('unconfirmed');
    expect(t.host.calls).toEqual([]);
  });

  it('is single-flight per publication', async () => {
    const t = setup(record('unconfirmed', [item(1, 'drafted', 7000)], { bulkPublishSentAt: NOW }));
    await Promise.all([t.reconciler.trigger(PR), t.reconciler.trigger(PR), t.reconciler.reconcile(t.store.rec)]);
    await t.reconciler.whenIdle();
    expect(t.host.callsOf('mr_notes')).toHaveLength(1);
    expect(t.store.finishes.filter((f) => f.won)).toHaveLength(1);
    expect(t.events).toHaveLength(1);
  });

  it('local mode (audit null) → no event', async () => {
    const t = setup(record('in_progress', [item(1, 'drafted', 7000)]), {}, { audit: false });
    await t.reconciler.reconcileAll();
    expect(t.store.rec.status).toBe('failed');
    expect(t.events).toHaveLength(0);
  });
});
