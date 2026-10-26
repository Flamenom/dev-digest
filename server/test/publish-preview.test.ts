/**
 * Pure publish preview (spec `specs/2026-10-21-gitlab-publish-findings.md`,
 * AC-2 – AC-8, AC-17, AC-18; plan T9; outdated-findings spec AC-1, AC-2,
 * AC-16, AC-18, AC-19, plan T7).
 */
import { describe, it, expect } from 'vitest';
import { PublishPreviewWithDeprecation } from '@devdigest/shared';
import {
  boundAnchorFor,
  buildPreview,
  previewDeprecation,
  reviewBlockers,
} from '../src/modules/publish/preview.js';
import type {
  FindingLiveState,
  PublishFindingRow,
  PublishReviewContext,
} from '../src/modules/publish/ports.js';

const HEAD = 'f00dbabe5';
const PATCH = '@@ -1,3 +1,4 @@\n line1\n+added2\n line3\n line4';

function finding(id: string, over: Partial<PublishFindingRow> = {}): PublishFindingRow {
  return {
    id,
    severity: 'WARNING',
    category: 'bug',
    title: `Finding ${id.slice(0, 4)}`,
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

const F = {
  ok: '00000000-0000-4000-8000-000000000001',
  dismissed: '00000000-0000-4000-8000-000000000002',
  published: '00000000-0000-4000-8000-000000000003',
  unconfirmed: '00000000-0000-4000-8000-000000000004',
  tooLong: '00000000-0000-4000-8000-000000000005',
  offDiff: '00000000-0000-4000-8000-000000000006',
  suggest: '00000000-0000-4000-8000-000000000007',
};

function ctx(over: {
  provider?: 'github' | 'gitlab';
  reviewHead?: string | null;
  prHead?: string | null;
  detailHead?: string | null;
  status?: PublishReviewContext['pr']['status'];
  findings?: PublishFindingRow[];
} = {}): PublishReviewContext {
  return {
    review: {
      id: 'r-1',
      workspaceId: 'w-1',
      prId: 'p-1',
      headSha: over.reviewHead === undefined ? HEAD : over.reviewHead,
    },
    pr: {
      id: 'p-1',
      number: 5,
      status: over.status ?? 'open',
      headSha: over.prHead === undefined ? HEAD : over.prHead,
      detailHeadSha: over.detailHead === undefined ? HEAD : over.detailHead,
    },
    repo: {
      provider: over.provider ?? 'gitlab',
      ref: { provider: over.provider ?? 'gitlab', fullName: 'group/sub/proj', owner: 'group/sub', name: 'proj' } as PublishReviewContext['repo']['ref'],
      webUrl: 'https://gitlab.com/group/sub/proj',
    },
    findings: over.findings ?? [finding(F.ok)],
    files: [{ path: 'src/a.ts', patch: PATCH, previousPath: null, patchOmitted: null, changeType: 'modified' }],
  };
}

function live(findingId: string, over: Partial<FindingLiveState> = {}): FindingLiveState {
  return {
    findingId,
    publicationId: 'pub-1',
    publicationStatus: 'published',
    state: 'published',
    discussionId: 'disc-1',
    noteId: 42,
    url: 'https://gitlab.com/group/sub/proj/-/merge_requests/5#note_42',
    publishedAt: new Date('2026-10-20T10:00:00Z'),
    publishedBy: { id: 'u-1', name: 'Jane' },
    publicationDeprecated: false,
    ...over,
  };
}

const base = { states: [], inProgress: null, tokenHealth: 'ok' as const, viewerCanPublish: true };

describe('buildPreview — per-finding reasons and anchors (AC-2, AC-9, AC-17, AC-18)', () => {
  it('reports one reason per fixture finding, the general anchor for off-diff, and parses as the contract', () => {
    const findings = [
      finding(F.ok),
      finding(F.dismissed, { dismissed_at: new Date() }),
      finding(F.published),
      finding(F.unconfirmed),
      finding(F.tooLong, { rationale: 'x'.repeat(1_000_001) }),
      finding(F.offDiff, { start_line: 40, end_line: 45 }),
      finding(F.suggest, { suggestion: '```ts\nconst x = 1;\n```' }),
    ];
    const preview = buildPreview({
      ...base,
      ctx: ctx({ findings }),
      states: [
        live(F.published),
        live(F.unconfirmed, { publicationId: 'pub-2', publicationStatus: 'unconfirmed', state: 'drafted', url: null, noteId: null, discussionId: null, publishedAt: null }),
      ],
    });

    expect(PublishPreviewWithDeprecation.safeParse(preview).success).toBe(true);
    expect(preview.blockers).toEqual([]);
    expect(preview.deprecation).toBeNull();
    expect(preview.mr_iid).toBe(5);
    expect(preview.viewer_can_publish).toBe(true);

    const by = new Map(preview.findings.map((f) => [f.finding_id, f]));
    expect(by.get(F.ok)).toMatchObject({ publishable: true, reason: null, published: null });
    expect(by.get(F.ok)!.anchor).toEqual({ kind: 'single_line', path: 'src/a.ts', start_line: 2, end_line: 2, off_diff_reason: null });
    expect(by.get(F.dismissed)).toMatchObject({ publishable: false, reason: 'dismissed' });
    expect(by.get(F.published)).toMatchObject({ publishable: false, reason: 'already_published' });
    expect(by.get(F.published)!.published).toEqual({
      discussion_id: 'disc-1',
      note_id: 42,
      url: 'https://gitlab.com/group/sub/proj/-/merge_requests/5#note_42',
      published_at: '2026-10-20T10:00:00.000Z',
      published_by: { id: 'u-1', name: 'Jane' },
      publication_id: 'pub-1',
      deprecated: false,
    });
    expect(by.get(F.unconfirmed)).toMatchObject({ publishable: false, reason: 'publish_unconfirmed', published: null });
    expect(by.get(F.tooLong)).toMatchObject({ publishable: false, reason: 'body_too_long' });
    expect(by.get(F.offDiff)).toMatchObject({ publishable: true, reason: null });
    expect(by.get(F.offDiff)!.anchor).toEqual({ kind: 'general', path: 'src/a.ts', start_line: 40, end_line: 45, off_diff_reason: 'not_on_diff_line' });
    expect(by.get(F.suggest)!.suggestion_eligible).toBe(true);
    expect(by.get(F.ok)!.suggestion_eligible).toBe(false);
  });

  it('drops a non-https link to null ("link unavailable")', () => {
    const preview = buildPreview({
      ...base,
      ctx: ctx({ findings: [finding(F.published)] }),
      states: [live(F.published, { url: 'javascript:alert(1)' })],
    });
    expect(preview.findings[0]!.published!.url).toBeNull();
  });

  it('a patch-unavailable file yields a general anchor with patch_unavailable (AC-10)', () => {
    const c = ctx();
    c.files = [{ path: 'src/a.ts', patch: null, previousPath: null, patchOmitted: 'too_large', changeType: 'modified' }];
    const preview = buildPreview({ ...base, ctx: c });
    expect(preview.findings[0]!.anchor.off_diff_reason).toBe('patch_unavailable');
    expect(preview.findings[0]!.publishable).toBe(true);
  });
});

describe('reviewBlockers (AC-3 – AC-8)', () => {
  const codes = (c: PublishReviewContext, extra: Partial<typeof base> = {}) =>
    reviewBlockers({ ctx: c, inProgress: null, tokenHealth: 'ok', ...extra }).map((b) => b.code);

  it('GitHub → only provider_not_supported, mr_iid null (AC-3)', () => {
    const c = ctx({ provider: 'github', reviewHead: null, status: 'merged' });
    expect(codes(c, { tokenHealth: null, inProgress: { id: 'x' } } as never)).toEqual(['provider_not_supported']);
    expect(buildPreview({ ...base, ctx: c }).mr_iid).toBeNull();
  });

  it('legacy review → no review_head_unknown blocker any more, publishable (outdated AC-2)', () => {
    expect(codes(ctx({ reviewHead: null }))).toEqual([]);
  });

  it('head moved or detail head stale → no review_diff_outdated blocker any more (outdated AC-2)', () => {
    expect(codes(ctx({ prHead: 'beef' }))).toEqual([]);
    expect(codes(ctx({ detailHead: 'beef' }))).toEqual([]);
    expect(codes(ctx({ detailHead: null }))).toEqual([]);
  });

  it('an in-progress publication → publish_in_progress with its id (AC-6)', () => {
    const blockers = reviewBlockers({ ctx: ctx(), inProgress: { id: 'pub-9' }, tokenHealth: 'ok' });
    expect(blockers).toEqual([expect.objectContaining({ code: 'publish_in_progress', publication_id: 'pub-9' })]);
  });

  it('token states map to their blockers; unchecked → none (AC-7)', () => {
    expect(codes(ctx(), { tokenHealth: null } as never)).toEqual(['gitlab_token_missing']);
    expect(codes(ctx(), { tokenHealth: 'insufficient_scope' } as never)).toEqual(['gitlab_token_insufficient_scope']);
    expect(codes(ctx(), { tokenHealth: 'invalid' } as never)).toEqual(['gitlab_token_invalid']);
    expect(codes(ctx(), { tokenHealth: 'unchecked' } as never)).toEqual([]);
  });

  it('merged / closed → pr_not_open; an open draft MR is not blocked (AC-8)', () => {
    expect(codes(ctx({ status: 'merged' }))).toEqual(['pr_not_open']);
    expect(codes(ctx({ status: 'closed' }))).toEqual(['pr_not_open']);
    expect(codes(ctx({ status: 'open' }))).toEqual([]);
  });

  it('keeps the AC-3 – AC-8 order when several apply, and findings are still listed (AC-7)', () => {
    const c = ctx({ reviewHead: null, status: 'merged' });
    const preview = buildPreview({ ...base, ctx: c, inProgress: { id: 'pub-9' }, tokenHealth: null });
    expect(preview.blockers.map((b) => b.code)).toEqual([
      'pr_not_open',
      'publish_in_progress',
      'gitlab_token_missing',
    ]);
    expect(preview.findings).toHaveLength(1);
  });
});

describe('buildPreview — deprecated reviews (outdated-findings AC-1, AC-2, AC-16, AC-18, AC-19)', () => {
  const NEWER = 'c0ffee123';
  const suggestFinding = finding(F.suggest, { suggestion: '```ts\nconst x = 1;\n```' });
  const fixtures = {
    legacy: ctx({ reviewHead: null, findings: [finding(F.ok), suggestFinding] }),
    // The MR was synced to a newer head after the run: PR head + persisted files moved on.
    outdated: ctx({ prHead: NEWER, detailHead: NEWER, findings: [finding(F.ok), suggestFinding] }),
    current: ctx({ findings: [finding(F.ok), suggestFinding] }),
  };

  it('reports the deprecation from persisted state: head_unknown / head_moved / null (AC-1)', () => {
    expect(previewDeprecation(fixtures.legacy)).toEqual({ reason: 'head_unknown', reviewed_head_sha: null });
    expect(previewDeprecation(fixtures.outdated)).toEqual({ reason: 'head_moved', reviewed_head_sha: HEAD });
    expect(previewDeprecation(fixtures.current)).toBeNull();
    for (const [name, c] of Object.entries(fixtures)) {
      const preview = buildPreview({ ...base, ctx: c });
      expect(PublishPreviewWithDeprecation.safeParse(preview).success, name).toBe(true);
      expect(preview.deprecation).toEqual(previewDeprecation(c));
    }
  });

  it('legacy and outdated reviews are publishable with no blockers; merged still blocks (AC-2)', () => {
    for (const c of [fixtures.legacy, fixtures.outdated]) {
      const preview = buildPreview({ ...base, ctx: c });
      expect(preview.blockers).toEqual([]);
      expect(preview.findings.every((f) => f.publishable)).toBe(true);
    }
    const merged = buildPreview({ ...base, ctx: ctx({ reviewHead: null, status: 'merged' }) });
    expect(merged.blockers.map((b) => b.code)).toEqual(['pr_not_open']);
  });

  it('head_moved → every anchor deferred; head_unknown → general review_head_unknown (AC-19)', () => {
    const moved = buildPreview({ ...base, ctx: fixtures.outdated });
    expect(moved.findings.map((f) => f.anchor)).toEqual([
      { kind: 'deferred', path: 'src/a.ts', start_line: 2, end_line: 2, off_diff_reason: null },
      { kind: 'deferred', path: 'src/a.ts', start_line: 2, end_line: 2, off_diff_reason: null },
    ]);
    const unknown = buildPreview({ ...base, ctx: fixtures.legacy });
    for (const f of unknown.findings) {
      expect(f.anchor).toEqual({ kind: 'general', path: 'src/a.ts', start_line: 2, end_line: 2, off_diff_reason: 'review_head_unknown' });
    }
  });

  it('stale persisted files on a current head → deferred anchors, deprecation null (Q1)', () => {
    const stale = buildPreview({ ...base, ctx: ctx({ detailHead: 'beef', findings: [finding(F.ok)] }) });
    expect(stale.deprecation).toBeNull();
    expect(stale.findings[0]!.anchor.kind).toBe('deferred');
    expect(stale.findings[0]!.anchor.off_diff_reason).toBeNull();
    expect(stale.findings[0]!.suggestion_eligible).toBe(false);
  });

  it('no suggestion is eligible while deprecated; the current review keeps it (AC-16)', () => {
    for (const c of [fixtures.legacy, fixtures.outdated]) {
      expect(buildPreview({ ...base, ctx: c }).findings.every((f) => !f.suggestion_eligible)).toBe(true);
    }
    const current = buildPreview({ ...base, ctx: fixtures.current });
    expect(current.findings.find((f) => f.finding_id === F.suggest)!.suggestion_eligible).toBe(true);
  });

  it('a near-limit body → body_too_long, deferred or not, via the worst-case bound (AC-18)', () => {
    // Fits without overhead but not with the worst-case deprecated + location overhead.
    const near = (rationale: string) => [finding(F.tooLong, { rationale })];
    const probe = (c: PublishReviewContext) => buildPreview({ ...base, ctx: c }).findings[0]!;
    let lo = 900_000;
    let hi = 1_000_000;
    // Binary-search the longest rationale the current (positioned) review accepts.
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (probe(ctx({ findings: near('x'.repeat(mid)) })).reason == null) lo = mid;
      else hi = mid - 1;
    }
    const over = 'x'.repeat(lo + 1);
    expect(probe(ctx({ findings: near('x'.repeat(lo)) })).reason).toBeNull();
    expect(probe(ctx({ findings: near(over) })).reason).toBe('body_too_long');
    expect(probe(ctx({ reviewHead: null, findings: near(over) })).reason).toBe('body_too_long');
    expect(probe(ctx({ prHead: NEWER, detailHead: NEWER, findings: near(over) })).reason).toBe('body_too_long');
    // The deferred bound anchor is the general one.
    expect(boundAnchorFor(finding(F.ok), null)).toMatchObject({ kind: 'general', offDiffReason: 'not_on_diff_line' });
  });

  it('a link published by a deprecated publication reads deprecated: true (AC-24, Q2)', () => {
    const preview = buildPreview({
      ...base,
      ctx: ctx({ findings: [finding(F.published)] }),
      states: [live(F.published, { publicationDeprecated: true })],
    });
    expect(preview.findings[0]!.published).toMatchObject({ publication_id: 'pub-1', deprecated: true });
  });
});
