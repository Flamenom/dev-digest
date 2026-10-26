/**
 * `PublishService` — the deprecation decision, the acknowledgement gate and
 * the read-only publish plan (spec
 * `specs/2026-10-23-gitlab-publish-outdated-findings.md`, AC-3, AC-4, AC-5,
 * AC-11, AC-21, AC-25; plan T9). Hermetic: an in-memory `PublishStore` fake
 * and the recording `MockGitLabClient` — every "N GitLab requests" assertion
 * reads `host.calls`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  PublicationWithDeprecation,
  PublishPlan,
  type GitLabMrDiffVersion,
  type HostRepoRef,
  type PrFileHost,
} from '@devdigest/shared';
import { AppError } from '../src/platform/errors.js';
import { MockGitLabClient } from '../src/adapters/mocks.js';
import { DEPRECATED_NOT_ACKNOWLEDGED_MESSAGE } from '../src/modules/publish/codes.js';
import { PublishService, type PublishServiceDeps } from '../src/modules/publish/service.js';
import type { PublishRunInput } from '../src/modules/publish/executor.js';
import type {
  CreatePublicationInput,
  PublicationRecord,
  PublicationStartDecision,
  PublishFindingRow,
  PublishGitLabHost,
  PublishReviewContext,
  PublishStore,
} from '../src/modules/publish/ports.js';

const WS = '11111111-1111-4111-8111-111111111111';
const REVIEW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PUB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const IID = 5;
const REVIEWED = 'abcdef0123456789abcdef0123456789abcdef01';
const LIVE = '9999999999999999999999999999999999999999';
const PATCH = '@@ -1,3 +1,4 @@\n line1\n+added2\n line3\n line4';
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const F_ON = ID(1); //   src/a.ts:2 — on the persisted diff
const F_VER = ID(2); //  src/v.ts:10 — on the reviewed version's diff only
const F_OFF = ID(3); //  src/a.ts:50 — on neither

const REF = {
  provider: 'gitlab',
  host: 'gitlab.com',
  owner: 'group/sub',
  name: 'proj',
  fullName: 'group/sub/proj',
} as unknown as HostRepoRef;

const VERSION: GitLabMrDiffVersion = {
  id: 7,
  headSha: REVIEWED,
  baseSha: 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1',
  startSha: 'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2',
  createdAt: '2026-10-20T10:00:00Z',
};
const VERSION_FILES: PrFileHost[] = [
  { path: 'src/v.ts', additions: 3, deletions: 0, patch: '@@ -9,1 +9,4 @@\n ctx\n+x\n+y\n+z', change_type: 'modified' },
];

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

function makeCtx(
  over: Partial<{ provider: 'github' | 'gitlab'; reviewHead: string | null; detailHead: string | null }> = {},
): PublishReviewContext {
  return {
    review: { id: REVIEW, workspaceId: WS, prId: 'pr-1', headSha: over.reviewHead === undefined ? REVIEWED : over.reviewHead },
    pr: {
      id: 'pr-1',
      number: IID,
      status: 'open',
      headSha: REVIEWED,
      detailHeadSha: over.detailHead === undefined ? REVIEWED : over.detailHead,
    },
    repo: { provider: over.provider ?? 'gitlab', ref: REF, webUrl: 'https://gitlab.com/group/sub/proj' },
    findings: [
      finding(F_ON),
      finding(F_VER, { file: 'src/v.ts', start_line: 10, end_line: 10 }),
      finding(F_OFF, { start_line: 50, end_line: 50 }),
    ],
    files: [{ path: 'src/a.ts', patch: PATCH, previousPath: null, patchOmitted: null, changeType: 'modified' }],
  };
}

class FakeStore implements Partial<PublishStore> {
  ctx: PublishReviewContext = makeCtx();
  created: CreatePublicationInput[] = [];
  deleted: string[] = [];
  startDecisions: PublicationStartDecision[] = [];

  loadReviewContext = async (ws: string, id: string) => (ws === WS && id === REVIEW ? this.ctx : null);
  findingStates = async () => [];
  inProgressForPr = async () => null;
  createPublication = async (input: CreatePublicationInput): Promise<PublicationRecord> => {
    this.created.push(input);
    const now = new Date('2026-10-23T12:00:00Z');
    return {
      id: PUB,
      workspaceId: input.workspaceId,
      reviewId: input.reviewId,
      prId: input.prId,
      createdBy: null,
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
  };
  setStartDecision = async (_id: string, decision: PublicationStartDecision) => {
    this.startDecisions.push(decision);
  };
  deletePublication = async (id: string) => {
    this.deleted.push(id);
  };
}

function harness(host: PublishGitLabHost & { calls?: unknown } = new MockGitLabClient()) {
  const store = new FakeStore();
  const started: PublishRunInput[] = [];
  const deps: PublishServiceDeps = {
    store: store as unknown as PublishStore,
    gitlab: { resolve: async () => ({ host, serviceAccount: 'devdigest-bot' }) },
    tokenHealth: async () => 'ok',
    actorName: async () => null,
    footerEnabled: false,
    runner: { start: (input) => void started.push(input) },
    reconciler: { trigger: () => undefined },
    clock: { now: () => new Date('2026-10-23T12:00:00Z') },
  };
  return { service: new PublishService(deps), store, started };
}

async function rejection(p: Promise<unknown>): Promise<{ code: string; statusCode: number; message: string }> {
  try {
    await p;
  } catch (err) {
    return err as { code: string; statusCode: number; message: string };
  }
  throw new Error('expected a rejection');
}

let host: MockGitLabClient;
let h: ReturnType<typeof harness>;
beforeEach(() => {
  host = new MockGitLabClient({
    diffRefs: { [IID]: { headSha: LIVE } },
    versions: { [IID]: [VERSION] },
    versionFiles: { [VERSION.id]: VERSION_FILES },
  });
  h = harness(host);
});

const ALL = [F_ON, F_VER, F_OFF];

describe('PublishService.create — deprecation + acknowledgement (AC-3, AC-4)', () => {
  it('head moved, no flag → 409 review_diff_outdated with the AC-4 message, 1 refs read, 0 writes, publication deleted', async () => {
    const err = await rejection(h.service.create(WS, REVIEW, { finding_ids: [F_ON] }, 'u-1'));
    expect(err).toMatchObject({ code: 'review_diff_outdated', statusCode: 409, message: DEPRECATED_NOT_ACKNOWLEDGED_MESSAGE });
    expect(host.calls.map((c) => c.kind)).toEqual(['diff_refs']);
    expect(host.draftWrites).toEqual([]);
    expect(h.store.deleted).toEqual([PUB]);
    expect(h.store.startDecisions).toEqual([]);
    expect(h.started).toEqual([]);
  });

  it('head moved + flag → 202 deprecated head_moved; anchors deferred to the background, no version read before the 202', async () => {
    const pub = await h.service.create(WS, REVIEW, { finding_ids: ALL, acknowledge_deprecated: true }, 'u-1');
    expect(PublicationWithDeprecation.safeParse(pub).success).toBe(true);
    expect(pub).toMatchObject({ status: 'in_progress', deprecated: true, deprecation_reason: 'head_moved', reviewed_version_found: null, position_fallbacks: 0 });
    expect(host.calls.map((c) => c.kind)).toEqual(['diff_refs']);

    const run = h.started[0]!;
    expect(run.deprecation).toEqual({ reason: 'head_moved', reviewedHeadSha: REVIEWED });
    expect(run.anchorSource).toBe('reviewed_version');
    expect(run.reviewHeadSha).toBe(REVIEWED);
    expect(run.refs.headSha).toBe(LIVE); // the live refs; the executor swaps in the version's SHAs
    expect(run.items.every((i) => i.anchor === null)).toBe(true);

    expect(h.store.startDecisions).toEqual([
      {
        deprecationReason: 'head_moved',
        items: run.items.map((i) => ({ findingId: i.finding.id, anchorKind: 'deferred' })),
      },
    ]);
  });

  it('head unknown: no flag → 409 review_head_unknown; flag → 202 head_unknown, source none, every finding general', async () => {
    h.store.ctx = makeCtx({ reviewHead: null });
    const err = await rejection(h.service.create(WS, REVIEW, { finding_ids: [F_ON] }, 'u-1'));
    expect(err).toMatchObject({ code: 'review_head_unknown', statusCode: 409, message: DEPRECATED_NOT_ACKNOWLEDGED_MESSAGE });
    expect(h.store.deleted).toEqual([PUB]);

    const pub = await h.service.create(WS, REVIEW, { finding_ids: [F_ON], acknowledge_deprecated: true }, 'u-1');
    expect(pub).toMatchObject({ deprecated: true, deprecation_reason: 'head_unknown' });
    const run = h.started[0]!;
    expect(run.deprecation).toEqual({ reason: 'head_unknown', reviewedHeadSha: null });
    expect(run.anchorSource).toBe('none');
    expect(run.items[0]!.anchor).toMatchObject({ kind: 'general', offDiffReason: 'review_head_unknown' });
    expect(h.store.created[1]!.items[0]!.anchorKind).toBe('general');
  });

  it('a current head ignores the flag (AC-5): the run equals the unflagged one, base persisted anchors', async () => {
    host.opts.diffRefs = { [IID]: { headSha: REVIEWED } };
    const flagged = await h.service.create(WS, REVIEW, { finding_ids: ALL, acknowledge_deprecated: true }, 'u-1');
    const plain = await h.service.create(WS, REVIEW, { finding_ids: ALL }, 'u-1');
    expect(flagged).toMatchObject({ deprecated: false, deprecation_reason: null });
    expect(plain).toEqual(flagged);
    const [a, b] = h.started;
    expect(a).toEqual(b);
    expect(a).toMatchObject({ deprecation: null, anchorSource: 'persisted', reviewHeadSha: REVIEWED });
    expect(a!.items.map((i) => i.anchor?.kind)).toEqual(['single_line', 'general', 'general']);
    expect(host.calls.map((c) => c.kind)).toEqual(['diff_refs', 'diff_refs']);
  });

  it('stale persisted files on a current head → not deprecated, anchored on the reviewed version (plan Q1)', async () => {
    host.opts.diffRefs = { [IID]: { headSha: REVIEWED } };
    h.store.ctx = makeCtx({ detailHead: 'olddetail' });
    const pub = await h.service.create(WS, REVIEW, { finding_ids: [F_ON] }, 'u-1');
    expect(pub.deprecated).toBe(false);
    expect(h.store.created[0]!.items[0]!.anchorKind).toBe('deferred');
    expect(h.started[0]).toMatchObject({ deprecation: null, anchorSource: 'reviewed_version' });
  });

  it('a non-boolean acknowledge_deprecated → 400 publish_summary_invalid with 0 GitLab requests', async () => {
    const err = await rejection(h.service.create(WS, REVIEW, { finding_ids: [F_ON], acknowledge_deprecated: 'yes' }, 'u-1'));
    expect(err).toMatchObject({ code: 'publish_summary_invalid', statusCode: 400 });
    expect(host.calls).toEqual([]);
    expect(h.store.created).toEqual([]);
  });

  it('300 ms per GitLab call → the 202 arrives in under 1 s, with no version read before it (AC-11)', async () => {
    const order: string[] = [];
    const delay = <T>(kind: string, fn: () => Promise<T>) => async () => {
      order.push(kind);
      await new Promise((r) => setTimeout(r, 300));
      return fn();
    };
    const slow: PublishGitLabHost = {
      ...host,
      getDiffRefs: (ref, iid) => delay('diff_refs', () => host.getDiffRefs(ref, iid))(),
      listMrDiffVersions: (ref, iid, o) => delay('mr_versions', () => host.listMrDiffVersions(ref, iid, o))(),
      getMrDiffVersionFiles: (ref, iid, v) => delay('mr_version', () => host.getMrDiffVersionFiles(ref, iid, v))(),
    } as PublishGitLabHost;
    h = harness(slow);
    const t0 = Date.now();
    await h.service.create(WS, REVIEW, { finding_ids: ALL, acknowledge_deprecated: true }, 'u-1');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(order).toEqual(['diff_refs']);
  });
});

describe('PublishService.publishPlan (AC-21) — GETs only', () => {
  const READS = new Set(['diff_refs', 'draft_notes', 'mr_versions', 'mr_version']);

  it('head moved: live deprecation + placement against the reviewed version', async () => {
    const plan = await h.service.publishPlan(WS, REVIEW, { finding_ids: ALL.join(',') });
    expect(PublishPlan.safeParse(plan).success).toBe(true);
    expect(plan).toEqual({
      other_drafts: 0,
      plan_available: true,
      deprecation: { reason: 'head_moved', reviewed_head_sha: REVIEWED, live_head_sha: LIVE },
      placement: { positioned: 1, general: 2 },
    });
    expect(host.calls.every((c) => READS.has(c.kind))).toBe(true);
    expect(host.calls.map((c) => c.kind).sort()).toEqual(['diff_refs', 'draft_notes', 'mr_version', 'mr_versions']);
    expect(host.draftWrites).toEqual([]);
  });

  it('a current head: no deprecation, placement against the persisted diff, no version reads', async () => {
    host.opts.diffRefs = { [IID]: { headSha: REVIEWED } };
    const plan = await h.service.publishPlan(WS, REVIEW, { finding_ids: `${F_ON}, ${F_OFF}` });
    expect(plan).toEqual({ other_drafts: 0, plan_available: true, deprecation: null, placement: { positioned: 1, general: 1 } });
    expect(host.calls.map((c) => c.kind).sort()).toEqual(['diff_refs', 'draft_notes']);
  });

  it('a versions 503 → plan_available with every finding general', async () => {
    host.opts.versionErrors = { mr_versions: [new AppError('gitlab_comment_failed', 'GitLab is unavailable', 503)] };
    const plan = await h.service.publishPlan(WS, REVIEW, { finding_ids: ALL.join(',') });
    expect(plan).toMatchObject({ plan_available: true, placement: { positioned: 0, general: 3 } });
  });

  it('a refs 502 → plan_available false, placement null, no deprecation key; drafts still counted', async () => {
    host.opts.errors = { diff_refs: new AppError('gitlab_comment_failed', 'GitLab is unavailable', 502) };
    const plan = await h.service.publishPlan(WS, REVIEW, { finding_ids: F_ON });
    expect(plan).toEqual({ other_drafts: 0, plan_available: false, placement: null });
    expect('deprecation' in plan).toBe(false);
  });

  it('a fatal version read (404) → plan_available false', async () => {
    host.opts.versionFiles = {};
    const plan = await h.service.publishPlan(WS, REVIEW, { finding_ids: F_ON });
    expect(plan).toMatchObject({ plan_available: false, placement: null });
  });

  it('validation: GitHub → 400 provider_not_supported; foreign / malformed ids → 400 publish_selection_invalid; 0 GitLab calls', async () => {
    for (const query of [{ finding_ids: ID(99) }, { finding_ids: 'nope' }, {}, { finding_ids: `${F_ON},${F_ON}` }]) {
      const err = await rejection(h.service.publishPlan(WS, REVIEW, query));
      expect(err, JSON.stringify(query)).toMatchObject({ code: 'publish_selection_invalid', statusCode: 400 });
    }
    h.store.ctx = makeCtx({ provider: 'github' });
    const err = await rejection(h.service.publishPlan(WS, REVIEW, { finding_ids: F_ON }));
    expect(err).toMatchObject({ code: 'provider_not_supported', statusCode: 400 });
    expect(host.calls).toEqual([]);
  });
});
