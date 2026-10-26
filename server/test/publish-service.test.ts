/**
 * `PublishService` — synchronous validation, lock, gate and diff-refs pre-check
 * (spec `specs/2026-10-21-gitlab-publish-findings.md`, AC-2, AC-12, AC-20 –
 * AC-22, AC-38; plan T9, Q1). Hermetic: an in-memory `PublishStore` fake and the
 * recording `MockGitLabClient` — every assertion on "0 GitLab requests" reads
 * `host.calls`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PublicationWithDeprecation, type GitLabTokenHealth, type HostRepoRef } from '@devdigest/shared';
import { MockGitLabClient } from '../src/adapters/mocks.js';
import { buildMarker } from '../src/modules/_shared/publish-marker.js';
import { PublishService, type PublishServiceDeps } from '../src/modules/publish/service.js';
import type { PublishRunInput } from '../src/modules/publish/executor.js';
import {
  FindingAlreadyPublishedError,
  PublishInProgressError,
  type CreatePublicationInput,
  type FindingLiveState,
  type PublicationRecord,
  type PublicationStartDecision,
  type PublishFindingRow,
  type PublishReviewContext,
  type PublishStore,
} from '../src/modules/publish/ports.js';

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '99999999-9999-4999-8999-999999999999';
const REVIEW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HEAD = 'f00dbabe5';
const PATCH = '@@ -1,3 +1,4 @@\n line1\n+added2\n line3\n line4';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const F_OK = ID(1);
const F_CRIT = ID(2);
const F_DISMISSED = ID(3);
const F_PUBLISHED = ID(4);
const F_OFFDIFF = ID(5);
const FOREIGN = ID(99);

function finding(id: string, over: Partial<PublishFindingRow> = {}): PublishFindingRow {
  return {
    id,
    severity: 'WARNING',
    category: 'bug',
    title: 'A finding',
    rationale: 'Because.',
    suggestion: null,
    kind: 'finding',
    evidence: null,
    file: 'src/a.ts',
    start_line: 2,
    end_line: 2,
    dismissed_at: null,
    ...over,
  };
}

const REF = {
  provider: 'gitlab',
  host: 'gitlab.com',
  owner: 'group/sub',
  name: 'proj',
  fullName: 'group/sub/proj',
} as unknown as HostRepoRef;

function makeCtx(over: Partial<{ provider: 'github' | 'gitlab'; reviewHead: string | null }> = {}): PublishReviewContext {
  return {
    review: { id: REVIEW, workspaceId: WS, prId: 'pr-1', headSha: over.reviewHead === undefined ? HEAD : over.reviewHead },
    pr: { id: 'pr-1', number: 5, status: 'open', headSha: HEAD, detailHeadSha: HEAD },
    repo: { provider: over.provider ?? 'gitlab', ref: REF, webUrl: 'https://gitlab.com/group/sub/proj' },
    findings: [
      finding(F_OK),
      finding(F_CRIT, { severity: 'CRITICAL', file: 'src/z.ts' }),
      finding(F_DISMISSED, { dismissed_at: new Date() }),
      finding(F_PUBLISHED),
      finding(F_OFFDIFF, { start_line: 50, end_line: 60 }),
    ],
    files: [{ path: 'src/a.ts', patch: PATCH, previousPath: null, patchOmitted: null, changeType: 'modified' }],
  };
}

/** In-memory `PublishStore` — only what the service touches is meaningful. */
class FakeStore implements Partial<PublishStore> {
  ctx: PublishReviewContext | null = makeCtx();
  live: FindingLiveState[] = [
    {
      findingId: F_PUBLISHED,
      publicationId: 'old-pub',
      publicationStatus: 'published',
      state: 'published',
      discussionId: 'd',
      noteId: 1,
      url: 'https://gitlab.com/group/sub/proj/-/merge_requests/5#note_1',
      publishedAt: new Date('2026-10-01T00:00:00Z'),
      publishedBy: { id: 'u', name: 'Jane' },
    },
  ];
  inProgress: { id: string; reviewId: string } | null = null;
  created: CreatePublicationInput[] = [];
  deleted: string[] = [];
  records = new Map<string, PublicationRecord>();
  createError: Error | null = null;

  loadReviewContext = async (ws: string, id: string) => (ws === WS && id === REVIEW ? this.ctx : null);
  findingStates = async (ids: readonly string[]) => this.live.filter((l) => ids.includes(l.findingId));
  inProgressForPr = async () => this.inProgress;
  createPublication = async (input: CreatePublicationInput): Promise<PublicationRecord> => {
    if (this.createError) throw this.createError;
    this.created.push(input);
    const now = new Date('2026-10-21T12:00:00Z');
    const record: PublicationRecord = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      workspaceId: input.workspaceId,
      reviewId: input.reviewId,
      prId: input.prId,
      createdBy: input.createdBy ? { id: input.createdBy, name: 'Jane' } : null,
      status: 'in_progress',
      code: null,
      message: null,
      requested: input.items.length,
      drafted: 0,
      published: 0,
      failed: 0,
      generalNotes: 0,
      applicableSuggestions: 0,
      otherDraftsPublished: 0,
      hasSummary: input.hasSummary,
      applySuggestions: input.applySuggestions,
      diffHeadSha: null,
      deprecated: false,
      deprecationReason: null,
      reviewedVersionFound: null,
      positionFallbacks: 0,
      bulkPublishSentAt: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      items: input.items.map((i) => ({
        findingId: i.findingId,
        position: i.position,
        state: 'pending',
        code: null,
        anchorKind: i.anchorKind,
        draftId: null,
        discussionId: null,
        noteId: null,
        url: null,
        publishedAt: null,
      })),
    };
    this.records.set(record.id, record);
    return record;
  };
  startDecisions: { id: string; decision: PublicationStartDecision }[] = [];
  setStartDecision = async (id: string, decision: PublicationStartDecision) => {
    this.startDecisions.push({ id, decision });
  };
  deletePublication = async (id: string) => {
    this.deleted.push(id);
    this.records.delete(id);
  };
  getPublication = async (ws: string, id: string) => (ws === WS ? (this.records.get(id) ?? null) : null);
  listForReview = async (ws: string, reviewId: string) =>
    ws === WS ? [...this.records.values()].filter((r) => r.reviewId === reviewId) : [];
}

interface Harness {
  service: PublishService;
  store: FakeStore;
  host: MockGitLabClient;
  started: PublishRunInput[];
  triggered: string[];
  setHealth: (h: GitLabTokenHealth | null) => void;
  setAccess: (a: 'ok' | 'none' | Error) => void;
}

function harness(opts: { footerEnabled?: boolean; neverResolvingRunner?: boolean } = {}): Harness {
  const store = new FakeStore();
  const host = new MockGitLabClient();
  const started: PublishRunInput[] = [];
  const triggered: string[] = [];
  let health: GitLabTokenHealth | null = 'ok';
  let access: 'ok' | 'none' | Error = 'ok';
  const deps: PublishServiceDeps = {
    store: store as unknown as PublishStore,
    gitlab: {
      resolve: async () => {
        if (access instanceof Error) throw access;
        return access === 'none' ? null : { host, serviceAccount: 'devdigest-bot' };
      },
    },
    tokenHealth: async () => health,
    actorName: async () => ({ name: 'Jane\nDoe', email: 'jane@example.com' }),
    footerEnabled: opts.footerEnabled ?? false,
    runner: {
      start: (input) => {
        started.push(input);
        // Simulates a background task that never finishes — create must not await it.
        if (opts.neverResolvingRunner) void new Promise<void>(() => {});
      },
    },
    reconciler: { trigger: (prId) => void triggered.push(prId) },
    clock: { now: () => new Date('2026-10-21T12:00:00Z') },
  };
  return {
    service: new PublishService(deps),
    store,
    host,
    started,
    triggered,
    setHealth: (h) => (health = h),
    setAccess: (a) => (access = a),
  };
}

async function rejection(p: Promise<unknown>): Promise<{ code: string; statusCode: number; details?: unknown }> {
  try {
    await p;
  } catch (err) {
    return err as { code: string; statusCode: number; details?: unknown };
  }
  throw new Error('expected a rejection');
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('PublishService.preview (AC-2, Q3)', () => {
  it('returns the preview, triggers reconciliation, and makes 0 GitLab requests', async () => {
    const preview = await h.service.preview(WS, REVIEW, true);
    expect(preview.findings).toHaveLength(5);
    const reasons = Object.fromEntries(preview.findings.map((f) => [f.finding_id, f.reason]));
    expect(reasons[F_DISMISSED]).toBe('dismissed');
    expect(reasons[F_PUBLISHED]).toBe('already_published');
    expect(reasons[F_OFFDIFF]).toBeNull();
    expect(h.triggered).toEqual(['pr-1']);
    expect(h.host.calls).toEqual([]);
  });

  it('404s for a review of another workspace', async () => {
    const err = await rejection(h.service.preview(OTHER_WS, REVIEW, true));
    expect(err).toMatchObject({ code: 'not_found', statusCode: 404 });
  });
});

describe('PublishService.create — AC-20 validation table (0 GitLab requests each)', () => {
  const cases: [string, () => unknown, string, number][] = [
    ['51 ids', () => ({ finding_ids: Array.from({ length: 51 }, (_, i) => ID(i + 100)) }), 'publish_selection_invalid', 400],
    ['an empty list', () => ({ finding_ids: [] }), 'publish_selection_invalid', 400],
    ['duplicate ids', () => ({ finding_ids: [F_OK, F_OK] }), 'publish_selection_invalid', 400],
    ['a case-variant duplicate', () => ({ finding_ids: [F_OK, F_OK.toUpperCase()] }), 'publish_selection_invalid', 400],
    ['a non-object body', () => null, 'publish_selection_invalid', 400],
    ['a foreign id', () => ({ finding_ids: [F_OK, FOREIGN] }), 'publish_selection_invalid', 400],
    ['a whitespace summary', () => ({ finding_ids: [F_OK], summary: '  \n ' }), 'publish_summary_invalid', 400],
    ['a 10,001-char summary', () => ({ finding_ids: [F_OK], summary: 'x'.repeat(10_001) }), 'publish_summary_invalid', 400],
    ['a non-boolean toggle', () => ({ finding_ids: [F_OK], apply_suggestions: 'yes' }), 'publish_summary_invalid', 400],
  ];

  it.each(cases)('%s → %s', async (_name, body, code, status) => {
    const err = await rejection(h.service.create(WS, REVIEW, body(), 'u-1'));
    expect(err).toMatchObject({ code, statusCode: status });
    expect(h.host.calls).toEqual([]);
    expect(h.store.created).toEqual([]);
  });

  it('a missing review → 404 before the body is even looked at', async () => {
    const err = await rejection(h.service.create(OTHER_WS, REVIEW, { finding_ids: [] }, 'u-1'));
    expect(err).toMatchObject({ code: 'not_found', statusCode: 404 });
  });

  it('a dismissed id → 400 finding_not_publishable listing it', async () => {
    const err = await rejection(h.service.create(WS, REVIEW, { finding_ids: [F_OK, F_DISMISSED] }, 'u-1'));
    expect(err).toMatchObject({ code: 'finding_not_publishable', statusCode: 400, details: { finding_ids: [F_DISMISSED] } });
    expect(h.host.calls).toEqual([]);
  });

  it('a published id → 409 finding_already_published listing it', async () => {
    const err = await rejection(h.service.create(WS, REVIEW, { finding_ids: [F_PUBLISHED] }, 'u-1'));
    expect(err).toMatchObject({ code: 'finding_already_published', statusCode: 409, details: { finding_ids: [F_PUBLISHED] } });
    expect(h.host.calls).toEqual([]);
  });

  it('a legacy review without the acknowledgement → 409 review_head_unknown after the refs read, publication deleted (outdated-findings AC-4)', async () => {
    h.store.ctx = makeCtx({ reviewHead: null });
    const err = await rejection(h.service.create(WS, REVIEW, { finding_ids: [F_OK] }, 'u-1'));
    expect(err).toMatchObject({ code: 'review_head_unknown', statusCode: 409 });
    expect(h.host.calls.map((c) => c.kind)).toEqual(['diff_refs']);
    expect(h.store.deleted).toHaveLength(1);
  });

  it('a GitHub review → 400 provider_not_supported', async () => {
    h.store.ctx = makeCtx({ provider: 'github' });
    const err = await rejection(h.service.create(WS, REVIEW, { finding_ids: [F_OK] }, 'u-1'));
    expect(err).toMatchObject({ code: 'provider_not_supported', statusCode: 400 });
    expect(h.host.calls).toEqual([]);
  });

  it('a token blocker from health → its code, before the lock', async () => {
    h.setHealth('invalid');
    const err = await rejection(h.service.create(WS, REVIEW, { finding_ids: [F_OK] }, 'u-1'));
    expect(err).toMatchObject({ code: 'gitlab_token_invalid' });
    expect(h.store.created).toEqual([]);
    expect(h.host.calls).toEqual([]);
  });

  it('an in-progress publication (blocker) → 409 publish_in_progress with its id', async () => {
    h.store.inProgress = { id: 'running-1', reviewId: 'other-review' };
    const err = await rejection(h.service.create(WS, REVIEW, { finding_ids: [F_OK] }, 'u-1'));
    expect(err).toMatchObject({ code: 'publish_in_progress', statusCode: 409, details: { publication_id: 'running-1' } });
    expect(h.host.calls).toEqual([]);
  });

  it('losing the lock race (store throws) → 409 publish_in_progress with the winner id, 0 GitLab requests (AC-22)', async () => {
    h.store.createError = new PublishInProgressError('winner-1');
    const err = await rejection(h.service.create(WS, REVIEW, { finding_ids: [F_OK] }, 'u-1'));
    expect(err).toMatchObject({ code: 'publish_in_progress', statusCode: 409, details: { publication_id: 'winner-1' } });
    expect(h.host.calls).toEqual([]);
  });

  it('the live-item guard (store throws) → 409 finding_already_published (AC-35)', async () => {
    h.store.createError = new FindingAlreadyPublishedError([F_OK]);
    const err = await rejection(h.service.create(WS, REVIEW, { finding_ids: [F_OK] }, 'u-1'));
    expect(err).toMatchObject({ code: 'finding_already_published', details: { finding_ids: [F_OK] } });
    expect(h.host.calls).toEqual([]);
  });
});

describe('PublishService.create — lock, gate, refs, background (AC-12, AC-21, Q1)', () => {
  it('accepts an off-diff id, sends in severity order, returns the in-progress publication', async () => {
    const pub = await h.service.create(
      WS,
      REVIEW,
      { finding_ids: [F_OK, F_OFFDIFF, F_CRIT], summary: 'LGTM overall' },
      'u-1',
    );
    expect(PublicationWithDeprecation.safeParse(pub).success).toBe(true);
    expect(pub).toMatchObject({ status: 'in_progress', requested: 3, has_summary: true, apply_suggestions: false });

    // One diff-refs read, no writes (AC-12).
    expect(h.host.calls.map((c) => c.kind)).toEqual(['diff_refs']);
    expect(h.host.draftWrites).toEqual([]);

    const created = h.store.created[0]!;
    expect(created.items.map((i) => i.findingId)).toEqual([F_CRIT, F_OK, F_OFFDIFF]);
    expect(created.items.map((i) => i.position)).toEqual([0, 1, 2]);
    expect(created.items.find((i) => i.findingId === F_OFFDIFF)!.anchorKind).toBe('general');

    const run = h.started[0]!;
    expect(run).toMatchObject({
      publicationId: pub.id,
      workspaceId: WS,
      iid: 5,
      webUrl: 'https://gitlab.com/group/sub/proj',
      serviceAccount: 'devdigest-bot',
      summary: 'LGTM overall',
      applySuggestions: false,
      footerName: null,
      budget: { remainingMs: 60_000 },
    });
    expect(run.refs.headSha).toBe(HEAD);
    expect(run.items.map((i) => i.finding.id)).toEqual([F_CRIT, F_OK, F_OFFDIFF]);
    expect(run.host).toBe(h.host);
  });

  it('google mode passes the sanitised footer name', async () => {
    h = harness({ footerEnabled: true });
    await h.service.create(WS, REVIEW, { finding_ids: [F_OK] }, 'u-1');
    expect(h.started[0]!.footerName).toBe('Jane Doe');
  });

  it('refs head ≠ review head, no acknowledgement → 409 review_diff_outdated, 1 read, 0 writes, publication deleted', async () => {
    h.host.opts.diffRefs = { 5: { headSha: 'newhead' } };
    const err = await rejection(h.service.create(WS, REVIEW, { finding_ids: [F_OK] }, 'u-1'));
    expect(err).toMatchObject({ code: 'review_diff_outdated', statusCode: 409 });
    expect(h.host.calls.map((c) => c.kind)).toEqual(['diff_refs']);
    expect(h.host.draftWrites).toEqual([]);
    expect(h.store.deleted).toEqual(['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
    expect(h.started).toEqual([]);
  });

  it('no stored token at the gate → 400 gitlab_token_missing, publication deleted', async () => {
    h.setAccess('none');
    const err = await rejection(h.service.create(WS, REVIEW, { finding_ids: [F_OK] }, 'u-1'));
    expect(err).toMatchObject({ code: 'gitlab_token_missing', statusCode: 400 });
    expect(h.store.deleted).toHaveLength(1);
    expect(h.host.calls).toEqual([]);
  });

  it('a gate error is rethrown as-is and the publication deleted', async () => {
    const gateErr = Object.assign(new Error('scope'), { code: 'gitlab_token_insufficient_scope', statusCode: 400 });
    h.setAccess(gateErr);
    const err = await rejection(h.service.create(WS, REVIEW, { finding_ids: [F_OK] }, 'u-1'));
    expect(err).toBe(gateErr);
    expect(h.store.deleted).toHaveLength(1);
  });

  it('a refs read error is rethrown and the publication deleted', async () => {
    const readErr = Object.assign(new Error('nope'), { code: 'gitlab_project_inaccessible', statusCode: 404 });
    h.host.opts.errors = { diff_refs: readErr };
    const err = await rejection(h.service.create(WS, REVIEW, { finding_ids: [F_OK] }, 'u-1'));
    expect(err).toBe(readErr);
    expect(h.store.deleted).toHaveLength(1);
    expect(h.started).toEqual([]);
  });

  it('resolves before the background task finishes (AC-21)', async () => {
    h = harness({ neverResolvingRunner: true });
    const pub = await h.service.create(WS, REVIEW, { finding_ids: [F_OK] }, 'u-1');
    expect(pub.status).toBe('in_progress');
    expect(h.started).toHaveLength(1);
  });
});

describe('PublishService.otherDraftsCount (AC-38)', () => {
  const mine = (f: string) =>
    `x\n\n${buildMarker({ workspaceId: WS, publicationId: ID(500), findingId: f })}`;
  const theirs = `y\n\n${buildMarker({ workspaceId: OTHER_WS, publicationId: ID(501), findingId: ID(502) })}`;

  it('counts drafts without this workspace marker — one list request, no writes', async () => {
    h.host.opts.drafts = {
      5: [
        { id: 1, author: 'devdigest-bot', note: 'human draft 1', position: null },
        { id: 2, author: 'devdigest-bot', note: 'human draft 2', position: null },
        { id: 3, author: 'devdigest-bot', note: theirs, position: null },
        { id: 4, author: 'devdigest-bot', note: mine(F_OK), position: null },
        { id: 5, author: 'someone-else', note: 'not ours', position: null },
      ],
    };
    expect(await h.service.otherDraftsCount(WS, REVIEW)).toEqual({ other_drafts: 3 });
    expect(h.host.calls.map((c) => c.kind)).toEqual(['draft_notes']);
    expect(h.host.draftWrites).toEqual([]);
  });

  it('a list error → null', async () => {
    h.host.opts.errors = { draft_notes: new Error('boom') };
    expect(await h.service.otherDraftsCount(WS, REVIEW)).toEqual({ other_drafts: null });
  });

  it('a gate error or no token → null', async () => {
    h.setAccess(new Error('gate'));
    expect(await h.service.otherDraftsCount(WS, REVIEW)).toEqual({ other_drafts: null });
    h.setAccess('none');
    expect(await h.service.otherDraftsCount(WS, REVIEW)).toEqual({ other_drafts: null });
  });

  it('GitHub → 400 provider_not_supported', async () => {
    h.store.ctx = makeCtx({ provider: 'github' });
    const err = await rejection(h.service.otherDraftsCount(WS, REVIEW));
    expect(err).toMatchObject({ code: 'provider_not_supported', statusCode: 400 });
  });
});

describe('PublishService.get / listForReview', () => {
  it('maps records to the contract, triggers reconciliation, and scopes by workspace', async () => {
    const pub = await h.service.create(WS, REVIEW, { finding_ids: [F_OK] }, 'u-1');
    h.triggered.length = 0;

    const got = await h.service.get(WS, pub.id);
    expect(PublicationWithDeprecation.safeParse(got).success).toBe(true);
    expect(got.items).toEqual([{ finding_id: F_OK, state: 'pending', code: null, link: null }]);
    expect(h.triggered).toEqual(['pr-1']);

    const list = await h.service.listForReview(WS, REVIEW);
    expect(list.map((p) => p.id)).toEqual([pub.id]);

    const err = await rejection(h.service.get(OTHER_WS, pub.id));
    expect(err).toMatchObject({ code: 'not_found', statusCode: 404 });
  });
});
