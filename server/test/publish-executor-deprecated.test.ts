/**
 * Background publish of deprecated / version-anchored runs (spec
 * `specs/2026-10-23-gitlab-publish-outdated-findings.md`, AC-6 – AC-17,
 * AC-25 – AC-28; plan T8). Hermetic: an in-memory `PublishStore` fake + the
 * `MockGitLabClient`. No Postgres (onion §10).
 */
import { describe, it, expect } from 'vitest';
import type { AuditEventInput, GitLabMrDiffVersion, HostRepoRef, PrFileHost } from '@devdigest/shared';
import { ReviewPublishAuditMetadataWithDeprecation } from '@devdigest/shared';
import { MockGitLabClient, type MockGitLabOptions } from '../src/adapters/mocks.js';
import { PublishExecutor, type PublishRunInput } from '../src/modules/publish/executor.js';
import { AppError } from '../src/platform/errors.js';
import {
  DEPRECATED_LINE_HEAD_UNKNOWN,
  DEPRECATED_LOCATION_SUFFIX,
  deprecatedLine,
} from '../src/modules/publish/note-body.js';
import { parseMarker } from '../src/modules/_shared/publish-marker.js';
import type {
  AnchorSource,
  FinishPublicationPatch,
  MarkItemDraftedOptions,
  PublicationAnchorResolution,
  PublicationRecord,
  PublishDeprecationState,
  PublishFindingRow,
  PublishStore,
} from '../src/modules/publish/ports.js';

// ---------- Fixtures ----------

const WS = '11111111-1111-4111-8111-111111111111';
const PUB = '22222222-2222-4222-8222-222222222222';
const REVIEW = '44444444-4444-4444-8444-444444444444';
const PR = '55555555-5555-4555-8555-555555555555';
const ACTOR = '66666666-6666-4666-8666-666666666666';
const fid = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BOT = 'devdigest-bot';
const IID = 5;
const WEB_URL = 'https://gitlab.com/acme/app';
const REF: HostRepoRef = { provider: 'gitlab', host: 'gitlab.com', fullName: 'acme/app', owner: 'acme', name: 'app' };
/** Live refs read by the service before the 202 — must NEVER reach a version-anchored position. */
const LIVE = { baseSha: 'live0base', startSha: 'live0start', headSha: '9999999999999999999999999999999999999999' };
const REVIEWED = 'abcdef0123456789abcdef0123456789abcdef01';
const VERSION: GitLabMrDiffVersion = {
  id: 7,
  headSha: REVIEWED,
  baseSha: 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1',
  startSha: 'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2',
  createdAt: '2026-10-20T10:00:00Z',
};
const NEWER_OTHER: GitLabMrDiffVersion = {
  id: 9,
  headSha: LIVE.headSha,
  baseSha: 'd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3',
  startSha: 'e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4',
  createdAt: '2026-10-22T10:00:00Z',
};
/** The reviewed version's diff: new-side 9 ctx, 10..12 added. */
const VERSION_FILES: PrFileHost[] = [
  {
    path: 'src/a.ts',
    additions: 3,
    deletions: 0,
    patch: '@@ -9,1 +9,4 @@\n ctx\n+x\n+y\n+z',
    change_type: 'modified',
  },
];
const HEAD_MOVED: PublishDeprecationState = { reason: 'head_moved', reviewedHeadSha: REVIEWED };
const HEAD_UNKNOWN: PublishDeprecationState = { reason: 'head_unknown', reviewedHeadSha: null };

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
    start_line: 11,
    end_line: 11,
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
      anchorKind: 'deferred',
      draftId: null,
      discussionId: null,
      noteId: null,
      url: null,
      publishedAt: null,
    })),
    ...over,
  };
}

/** In-memory PublishStore: the operations the executor uses, recording the new ones. */
class FakeStore implements PublishStore {
  pubs = new Map<string, PublicationRecord>();
  resolutions: PublicationAnchorResolution[] = [];
  draftedOpts: (MarkItemDraftedOptions | undefined)[] = [];
  onResolution: () => void = () => {};

  constructor(rec: PublicationRecord) {
    this.pubs.set(rec.id, rec);
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
  setAnchorResolution = async (p: string, res: PublicationAnchorResolution) => {
    this.resolutions.push(res);
    const r = this.get(p);
    r.reviewedVersionFound = res.reviewedVersionFound;
    r.diffHeadSha = res.diffHeadSha;
    for (const k of res.items) this.item(k.findingId, p).anchorKind = k.anchorKind;
    this.onResolution();
  };
  markItemDrafted = async (p: string, f: string, draftId: number, opts?: MarkItemDraftedOptions) => {
    this.draftedOpts.push(opts);
    const it = this.item(f, p);
    it.state = 'drafted';
    it.draftId = draftId;
    if (opts?.anchorKind) it.anchorKind = opts.anchorKind;
    const r = this.get(p);
    r.drafted += 1;
    if (opts?.positionFallback) {
      r.positionFallbacks += 1;
      r.generalNotes += 1;
    }
  };
  markItemFailed = async (p: string, f: string, code: string) => {
    const it = this.item(f, p);
    it.state = 'failed';
    it.code = code;
  };
  markItemsPublished = async (
    p: string,
    links: readonly { findingId: string; discussionId: string | null; noteId: number | null; url: string | null; publishedAt: Date }[],
  ) => {
    for (const l of links) {
      Object.assign(this.item(l.findingId, p), {
        state: 'published',
        discussionId: l.discussionId,
        noteId: l.noteId,
        url: l.url,
        publishedAt: l.publishedAt,
      });
    }
  };
  markItemsRolledBack = async (p: string, ids: readonly string[]) => {
    for (const f of ids) this.item(f, p).state = 'rolled_back';
  };
  rollBackLeftoverFindings = async () => {};
  setOtherDrafts = async (p: string, count: number) => {
    this.get(p).otherDraftsPublished = count;
  };
  setBulkPublishSent = async (p: string, at: Date) => {
    this.get(p).bulkPublishSentAt = at;
  };
  touch = async () => {};
  finish = async (p: string, from: readonly string[], patch: FinishPublicationPatch) => {
    const r = this.pubs.get(p);
    if (!r || !from.includes(r.status)) return false;
    Object.assign(r, { status: patch.status, code: patch.code, message: patch.message, finishedAt: patch.finishedAt }, patch.counters ?? {});
    return true;
  };
  getPublication = async () => null;
  listForReview = async () => [];
  reconcileCandidates = async () => [];
  markOrphanedUnconfirmed = async () => 0;
}

function setup(opts: {
  findings: PublishFindingRow[];
  deprecation: PublishDeprecationState | null;
  anchorSource: AnchorSource;
  gitlab?: MockGitLabOptions;
  summary?: string | null;
  applySuggestions?: boolean;
}) {
  const host = new MockGitLabClient({
    versions: { [IID]: [NEWER_OTHER, VERSION] },
    versionFiles: { [VERSION.id]: VERSION_FILES },
    ...opts.gitlab,
  });
  const store = new FakeStore(record(opts.findings, { hasSummary: opts.summary != null }));
  const events: AuditEventInput[] = [];
  const logs: unknown[] = [];
  const executor = new PublishExecutor({
    store,
    audit: { record: async (e) => void events.push(e) },
    clock: { now: () => new Date('2026-10-23T12:00:00Z') },
    log: { warn: (o: unknown) => logs.push(o), error: (o: unknown) => logs.push(o) },
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
    refs: LIVE,
    serviceAccount: BOT,
    host,
    items: opts.findings.map((f) => ({ finding: f, anchor: null })),
    summary: opts.summary ?? null,
    applySuggestions: opts.applySuggestions ?? false,
    footerName: null,
    budget: { remainingMs: 60_000 },
    deprecation: opts.deprecation,
    anchorSource: opts.anchorSource,
    reviewHeadSha: opts.deprecation?.reviewedHeadSha ?? (opts.anchorSource === 'none' ? null : REVIEWED),
  };
  return { host, store, events, logs, run: () => executor.run(input) };
}

type CreateWrite = Extract<MockGitLabClient['draftWrites'][number], { kind: 'create_draft_note' }>;
const creates = (h: MockGitLabClient) =>
  h.draftWrites.filter((w): w is CreateWrite => w.kind === 'create_draft_note');
const bulks = (h: MockGitLabClient) => h.draftWrites.filter((w) => w.kind === 'bulk_publish');
const versionCalls = (h: MockGitLabClient) => h.callsOf('mr_versions').length + h.callsOf('mr_version').length;
const rejected = (status: number) => ({ failure: { kind: 'rejected' as const, status } });
const SUGGESTION = '```ts\nconst y = 2;\n```';

// ---------- Tests ----------

describe('PublishExecutor — reviewed version anchoring (AC-6, AC-7, AC-14, AC-16, AC-17, AC-26, AC-28)', () => {
  it('positions with the version SHAs only, prefixes every body and the summary, never re-reads', async () => {
    const t = setup({
      findings: [
        finding(1, { severity: 'CRITICAL', start_line: 10, end_line: 12 }), // multi-line on the version
        finding(2, { suggestion: SUGGESTION }), // single added line 11 — eligible if not deprecated
        finding(3, { severity: 'SUGGESTION', file: 'src/gone.ts' }), // absent from the version
        finding(4, { severity: 'INFO', kind: 'secret_leak', start_line: 10, end_line: 10 }),
      ],
      deprecation: HEAD_MOVED,
      anchorSource: 'reviewed_version',
      summary: 'Overall fine',
      applySuggestions: true,
    });
    // AC-28: the host moves on after step 0 — the run must not notice.
    t.store.onResolution = () => {
      t.host.opts.versions = { [IID]: [{ ...VERSION, id: 99, headSha: 'f'.repeat(40) }] };
      t.host.opts.diffRefs = { [IID]: { headSha: 'f'.repeat(40) } };
    };

    await t.run();

    // AC-6: one versions page + one version diff read; AC-28: no refs read, no further version read.
    expect(t.host.callsOf('mr_versions')).toHaveLength(1);
    expect(t.host.callsOf('mr_version')).toHaveLength(1);
    expect(t.host.callsOf('diff_refs')).toHaveLength(0);

    const sent = creates(t.host);
    expect(sent).toHaveLength(4);
    // AC-7: positioned drafts carry the version's 3 SHAs, never the live refs.
    const positioned = sent.filter((w) => w.position != null);
    expect(positioned).toHaveLength(3);
    for (const w of positioned) {
      expect(w.position).toMatchObject({ baseSha: VERSION.baseSha, startSha: VERSION.startSha, headSha: VERSION.headSha });
    }
    expect(JSON.stringify(sent.map((w) => w.position))).not.toMatch(/live0|9999999999/);
    const byFinding = new Map(sent.map((w) => [parseMarker(w.note)!.findingId, w]));
    expect(byFinding.get(fid(1))!.position).toMatchObject({ newLine: 12, lineRange: { start: { newLine: 10 }, end: { newLine: 12 } } });
    expect(byFinding.get(fid(3))!.position).toBeNull();

    // AC-14: header line, then the deprecated line — every note, secret_leak and general included.
    const dep = deprecatedLine(HEAD_MOVED);
    expect(dep).toContain('`abcdef01`');
    for (const w of sent) {
      const lines = w.note.split('\n');
      expect(lines[0]).toMatch(/^\*\*(CRITICAL|WARNING|SUGGESTION|INFO)\*\* · /);
      expect(lines[1]).toBe(dep);
    }
    // AC-10 / AC-15: the absent file → general with the deprecated `not_on_diff_line` suffix.
    expect(byFinding.get(fid(3))!.note.split('\n')[2]).toContain(DEPRECATED_LOCATION_SUFFIX.not_on_diff_line);
    // AC-16: never an applicable suggestion on a deprecated run.
    expect(byFinding.get(fid(2))!.note).not.toContain('```suggestion');
    // AC-17: the summary begins with the deprecated line and a blank line.
    expect(bulks(t.host)).toHaveLength(1);
    expect((bulks(t.host)[0] as { note: string | null }).note!.startsWith(`${dep}\n\nOverall fine`)).toBe(true);

    // Persistence: resolution recorded once with the version head; final kinds.
    expect(t.store.resolutions).toEqual([
      {
        reviewedVersionFound: true,
        diffHeadSha: VERSION.headSha,
        items: expect.arrayContaining([
          { findingId: fid(1), anchorKind: 'multi_line' },
          { findingId: fid(2), anchorKind: 'single_line' },
          { findingId: fid(3), anchorKind: 'general' },
          { findingId: fid(4), anchorKind: 'single_line' },
        ]),
      },
    ]);
    const pub = t.store.get();
    expect(pub).toMatchObject({ status: 'published', published: 4, generalNotes: 1, applicableSuggestions: 0, positionFallbacks: 0 });

    // AC-26: audit carries the 4 fields and no SHA / body.
    expect(t.events).toHaveLength(1);
    const meta = ReviewPublishAuditMetadataWithDeprecation.parse(t.events[0]!.metadata);
    expect(meta).toMatchObject({
      outcome: 'published',
      deprecated: true,
      deprecation_reason: 'head_moved',
      reviewed_version_found: true,
      position_fallbacks: 0,
      applicable_suggestions: 0,
      has_summary: true,
    });
    const raw = JSON.stringify(t.events[0]!.metadata);
    for (const forbidden of [REVIEWED, REVIEWED.slice(0, 8), VERSION.baseSha, 'Overall fine', 'Title', 'Rationale', '+x']) {
      expect(raw).not.toContain(forbidden);
    }
    // NFR: logs never carry version-diff text.
    expect(JSON.stringify(t.logs)).not.toContain('+x');
  });
});

describe('PublishExecutor — reviewed version unavailable / fatal (AC-8, AC-9)', () => {
  it('no matching version → every finding general `reviewed_version_unavailable`, found=false', async () => {
    const t = setup({
      findings: [finding(1), finding(2, { start_line: 10, end_line: 12 })],
      deprecation: HEAD_MOVED,
      anchorSource: 'reviewed_version',
      gitlab: { versions: { [IID]: [NEWER_OTHER] } },
    });
    await t.run();
    expect(t.host.callsOf('mr_version')).toHaveLength(0);
    const sent = creates(t.host);
    expect(sent).toHaveLength(2);
    for (const w of sent) {
      expect(w.position).toBeNull();
      expect(w.note).toContain(DEPRECATED_LOCATION_SUFFIX.reviewed_version_unavailable);
    }
    expect(t.store.resolutions[0]).toMatchObject({ reviewedVersionFound: false, diffHeadSha: null });
    expect(t.store.get()).toMatchObject({ status: 'published', reviewedVersionFound: false, generalNotes: 2 });
    expect(ReviewPublishAuditMetadataWithDeprecation.parse(t.events[0]!.metadata)).toMatchObject({ reviewed_version_found: false });
  });

  it('versions read 5xx (transient) → all general, publish continues', async () => {
    const t = setup({
      findings: [finding(1)],
      deprecation: HEAD_MOVED,
      anchorSource: 'reviewed_version',
      gitlab: { versionErrors: { mr_versions: [new AppError('gitlab_comment_failed', 'GitLab is unavailable', 503)] } },
    });
    await t.run();
    expect(creates(t.host)).toHaveLength(1);
    expect(creates(t.host)[0]!.position).toBeNull();
    expect(t.store.get()).toMatchObject({ status: 'published', reviewedVersionFound: false });
  });

  it('versions read 401 → failed `gitlab_token_invalid`, 0 writes, items rolled back, no audit', async () => {
    const t = setup({
      findings: [finding(1), finding(2)],
      deprecation: HEAD_MOVED,
      anchorSource: 'reviewed_version',
      gitlab: { versionErrors: { mr_versions: [new AppError('gitlab_token_invalid', 'token invalid', 401)] } },
    });
    await t.run();
    expect(t.host.draftWrites).toEqual([]);
    expect(t.host.callsOf('draft_notes')).toHaveLength(0);
    expect(t.store.get()).toMatchObject({ status: 'failed', code: 'gitlab_token_invalid' });
    expect(t.store.get().items.map((i) => i.state)).toEqual(['rolled_back', 'rolled_back']);
    expect(t.store.resolutions).toEqual([]);
    expect(t.events).toEqual([]);
  });

  it('head unknown (`none`) → 0 version calls, every finding general `review_head_unknown`', async () => {
    const t = setup({
      findings: [finding(1), finding(2, { start_line: 10, end_line: 12 })],
      deprecation: HEAD_UNKNOWN,
      anchorSource: 'none',
    });
    await t.run();
    expect(versionCalls(t.host)).toBe(0);
    const sent = creates(t.host);
    expect(sent).toHaveLength(2);
    for (const w of sent) {
      expect(w.position).toBeNull();
      expect(w.note.split('\n')[1]).toBe(DEPRECATED_LINE_HEAD_UNKNOWN);
      expect(w.note).toContain(DEPRECATED_LOCATION_SUFFIX.review_head_unknown);
    }
    expect(t.store.resolutions[0]).toMatchObject({ reviewedVersionFound: null, diffHeadSha: null });
    expect(ReviewPublishAuditMetadataWithDeprecation.parse(t.events[0]!.metadata)).toMatchObject({
      deprecated: true,
      deprecation_reason: 'head_unknown',
      reviewed_version_found: null,
    });
  });
});

describe('PublishExecutor — position fallback (AC-12, AC-13, AC-27)', () => {
  it('deprecated: 400 positioned + 201 general → 2 creates, 1 draft, same marker, position_fallbacks 1', async () => {
    const t = setup({
      findings: [finding(1)],
      deprecation: HEAD_MOVED,
      anchorSource: 'reviewed_version',
      gitlab: { writeScript: { create_draft_note: [rejected(400)] } },
    });
    await t.run();
    const sent = creates(t.host);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.position).not.toBeNull();
    expect(sent[1]!.position).toBeNull();
    // AC-27: the fallback carries the same marker (same finding id).
    expect(parseMarker(sent[1]!.note)).toEqual(parseMarker(sent[0]!.note));
    expect(sent[1]!.note.split('\n')[1]).toBe(deprecatedLine(HEAD_MOVED));
    expect(sent[1]!.note).toContain(DEPRECATED_LOCATION_SUFFIX.position_rejected);
    expect(t.store.draftedOpts).toEqual([{ anchorKind: 'general', positionFallback: true }]);
    expect(t.store.get()).toMatchObject({ status: 'published', drafted: 1, published: 1, positionFallbacks: 1, generalNotes: 1 });
    expect(t.store.item(fid(1)).anchorKind).toBe('general');
    expect(ReviewPublishAuditMetadataWithDeprecation.parse(t.events[0]!.metadata)).toMatchObject({
      position_fallbacks: 1,
      general_notes: 1,
    });
  });

  it('deprecated multi-line: 400 / 400 / 400 → 3 creates (multi, single, general), finding failed', async () => {
    const t = setup({
      findings: [finding(1, { start_line: 10, end_line: 12 })],
      deprecation: HEAD_MOVED,
      anchorSource: 'reviewed_version',
      gitlab: { writeScript: { create_draft_note: [rejected(400), rejected(400), rejected(400)] } },
    });
    await t.run();
    const sent = creates(t.host);
    expect(sent).toHaveLength(3);
    expect(sent[0]!.position).toHaveProperty('lineRange');
    expect(sent[1]!.position).not.toBeNull();
    expect(sent[1]!.position).not.toHaveProperty('lineRange');
    expect(sent[2]!.position).toBeNull();
    expect(t.store.item(fid(1))).toMatchObject({ state: 'failed', code: 'gitlab_position_rejected' });
    expect(t.store.get()).toMatchObject({ status: 'failed', code: 'gitlab_position_rejected' });
    expect(bulks(t.host)).toHaveLength(0);
  });

  it('deprecated: 502 on the first create → 1 create, no re-send, rollback', async () => {
    const t = setup({
      findings: [finding(1), finding(2)],
      deprecation: HEAD_MOVED,
      anchorSource: 'reviewed_version',
      gitlab: { writeScript: { create_draft_note: [{ failure: { kind: 'unconfirmed' } }] } },
    });
    await t.run();
    expect(creates(t.host)).toHaveLength(1);
    expect(bulks(t.host)).toHaveLength(0);
    expect(t.store.get().status).toBe('failed');
    expect(t.store.get().items.map((i) => i.state)).toEqual(['rolled_back', 'rolled_back']);
  });

  it('non-deprecated version-anchored (stale files) run: 400 single-line → failed, no general re-send', async () => {
    const t = setup({
      findings: [finding(1, { suggestion: SUGGESTION })],
      deprecation: null,
      anchorSource: 'reviewed_version',
      applySuggestions: true,
      gitlab: {
        versions: { [IID]: [VERSION] },
        writeScript: { create_draft_note: [rejected(400)] },
      },
    });
    await t.run();
    const sent = creates(t.host);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.position).toMatchObject({ headSha: VERSION.headSha });
    // Not deprecated: base body (no deprecated line), the suggestion may be applicable.
    expect(sent[0]!.note).not.toContain('Deprecated');
    expect(sent[0]!.note).toContain('```suggestion');
    expect(t.store.item(fid(1))).toMatchObject({ state: 'failed', code: 'gitlab_position_rejected' });
    expect(t.store.get()).toMatchObject({ status: 'failed', reviewedVersionFound: true });
  });
});
