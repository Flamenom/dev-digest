/**
 * The shared version-anchor helper (outdated-findings spec AC-6 – AC-10, AC-19;
 * plan T5): version selection, read-failure classification, planning.
 */
import { describe, it, expect } from 'vitest';
import {
  PUBLISH_VERSIONS_MAX_PAGES,
  type GitLabDiffVersionsHost,
  type GitLabMrDiffVersion,
  type HostRepoRef,
  type PrFileHost,
} from '@devdigest/shared';
import { AppError } from '../src/platform/errors.js';
import {
  countPlacement,
  pickReviewedVersion,
  planAnchors,
  resolveReviewedVersion,
  toPersistedFiles,
  type PlannableFinding,
} from '../src/modules/publish/anchor-source.js';
import type { PublishLogger } from '../src/modules/publish/ports.js';

const REF: HostRepoRef = {
  provider: 'gitlab',
  host: 'gitlab.com',
  fullName: 'group/sub/project',
  owner: 'group/sub',
  name: 'project',
};
const IID = 7;
const H = 'a'.repeat(40);

// Same hunks as publish-anchor.test.ts:
// Hunk 0: new 1 a / 2 B / 3 B2 / 4 c / 5 d   Hunk 1: new 21 x / 22 y / 23 z / 24 w
const PATCH = [
  '@@ -1,4 +1,5 @@ function head()',
  ' a',
  '-b',
  '+B',
  '+B2',
  ' c',
  ' d',
  '@@ -20,3 +21,4 @@',
  ' x',
  '+y',
  '+z',
  '-q',
  ' w',
  '',
].join('\n');

const hostFile = (over: Partial<PrFileHost> = {}): PrFileHost => ({
  path: 'src/a.ts',
  additions: 4,
  deletions: 2,
  patch: PATCH,
  change_type: 'modified',
  previous_path: null,
  patch_omitted: null,
  ...over,
});

/** A version diff as `mapRestDiff` produces it. */
const VERSION_FILES: PrFileHost[] = [
  hostFile(),
  hostFile({ path: 'src/gone.ts', change_type: 'deleted', patch: '@@ -1,2 +0,0 @@\n-x\n-y\n' }),
  hostFile({ path: 'src/big.ts', patch: null, patch_omitted: 'too_large' }),
  hostFile({ path: 'src/collapsed.ts', patch: null, patch_omitted: 'collapsed' }),
  hostFile({ path: 'src/empty.ts', patch: null }),
  hostFile({ path: 'src/new-name.ts', previous_path: 'src/old-name.ts', change_type: 'renamed' }),
];

const version = (id: number, headSha: string, createdAt: string): GitLabMrDiffVersion => ({
  id,
  headSha,
  baseSha: `base-${id}`,
  startSha: `start-${id}`,
  createdAt,
});

interface FakeHost extends GitLabDiffVersionsHost {
  calls: { kind: 'list' | 'files'; arg: unknown }[];
}

function fakeHost(opts: {
  versions?: GitLabMrDiffVersion[];
  truncated?: boolean;
  files?: PrFileHost[];
  listError?: unknown;
  filesError?: unknown;
}): FakeHost {
  const calls: FakeHost['calls'] = [];
  return {
    calls,
    listMrDiffVersions: async (_ref, _iid, o) => {
      calls.push({ kind: 'list', arg: o });
      if (opts.listError) throw opts.listError;
      return { versions: opts.versions ?? [], truncated: opts.truncated ?? false };
    },
    getMrDiffVersionFiles: async (_ref, _iid, versionId) => {
      calls.push({ kind: 'files', arg: versionId });
      if (opts.filesError) throw opts.filesError;
      return opts.files ?? VERSION_FILES;
    },
  };
}

const finding = (id: string, start_line: number, end_line: number, file = 'src/a.ts'): PlannableFinding => ({
  id,
  file,
  start_line,
  end_line,
});

describe('toPersistedFiles', () => {
  it('maps previous_path / patch_omitted / change_type to the resolver shape', () => {
    expect(toPersistedFiles([hostFile({ path: 'n.ts', previous_path: 'o.ts', change_type: 'renamed' })])).toEqual([
      { path: 'n.ts', patch: PATCH, previousPath: 'o.ts', patchOmitted: null, changeType: 'renamed' },
    ]);
    expect(
      toPersistedFiles([{ path: 'x.ts', additions: 0, deletions: 0, patch: undefined }]),
    ).toEqual([{ path: 'x.ts', patch: null, previousPath: null, patchOmitted: null, changeType: null }]);
  });
});

describe('planAnchors on a version diff reproduces the base outcomes (AC-6, AC-10)', () => {
  const source = { kind: 'persisted' as const, files: toPersistedFiles(VERSION_FILES) };

  it('positions multi-line, nearest-to-end, context old+new and renamed old path', () => {
    const plan = planAnchors(
      [finding('multi', 2, 3), finding('nearest', 4, 10), finding('ctx', 1, 4), finding('renamed', 2, 2, 'src/new-name.ts')],
      source,
    );
    expect(plan.get('multi')).toMatchObject({ kind: 'multi_line', anchorLine: 3, allAdded: true });
    expect(plan.get('nearest')).toMatchObject({ kind: 'single_line', anchorLine: 5, anchorOldLine: 4 });
    const ctx = plan.get('ctx');
    expect(ctx).toMatchObject({ kind: 'multi_line' });
    if (ctx?.kind === 'multi_line') {
      expect(ctx.rangeStart).toEqual({ oldLine: 1, newLine: 1 });
      expect(ctx.rangeEnd).toEqual({ oldLine: 3, newLine: 4 });
    }
    expect(plan.get('renamed')).toMatchObject({ kind: 'single_line', oldPath: 'src/old-name.ts' });
    expect(countPlacement(plan)).toEqual({ positioned: 4, general: 0 });
  });

  it.each([
    ['too large', 'src/big.ts', 1, 2, 'patch_unavailable'],
    ['collapsed', 'src/collapsed.ts', 1, 2, 'patch_unavailable'],
    ['empty diff', 'src/empty.ts', 1, 2, 'patch_unavailable'],
    ['absent from the version', 'src/not-there.ts', 1, 2, 'not_on_diff_line'],
    ['deleted file', 'src/gone.ts', 1, 2, 'not_on_diff_line'],
    ['no new-side line in range', 'src/a.ts', 8, 15, 'not_on_diff_line'],
  ])('%s → general %s', (_label, file, s, e, reason) => {
    const plan = planAnchors([finding('f', s, e, file)], source);
    expect(plan.get('f')).toMatchObject({ kind: 'general', offDiffReason: reason });
  });
});

describe('pickReviewedVersion', () => {
  it('chooses the newest createdAt among versions with the reviewed head; equal createdAt → higher id', () => {
    const versions = [
      version(1, H, '2026-10-01T10:00:00Z'),
      version(5, H, '2026-10-02T10:00:00Z'),
      version(3, H, '2026-10-01T12:00:00Z'),
      version(9, 'b'.repeat(40), '2026-10-09T10:00:00Z'),
    ];
    expect(pickReviewedVersion(versions, H)?.id).toBe(5);
    expect(
      pickReviewedVersion([version(4, H, '2026-10-02T10:00:00Z'), version(6, H, '2026-10-02T10:00:00Z')], H)?.id,
    ).toBe(6);
    expect(pickReviewedVersion(versions, 'c'.repeat(40))).toBeNull();
  });
});

describe('resolveReviewedVersion (AC-6 – AC-8)', () => {
  it('found: lists with the page bound, reads the chosen version and carries its 3 SHAs (AC-7)', async () => {
    const host = fakeHost({
      versions: [version(11, H, '2026-10-01T10:00:00Z'), version(12, H, '2026-10-03T10:00:00Z')],
    });
    const r = await resolveReviewedVersion(host, REF, IID, H);
    expect(r.kind).toBe('found');
    if (r.kind !== 'found') return;
    expect(r.versionId).toBe(12);
    expect(r.refs).toEqual({ baseSha: 'base-12', startSha: 'start-12', headSha: H });
    expect(r.files).toEqual(toPersistedFiles(VERSION_FILES));
    expect(host.calls).toEqual([
      { kind: 'list', arg: { maxPages: PUBLISH_VERSIONS_MAX_PAGES } },
      { kind: 'files', arg: 12 },
    ]);
  });

  it('no matching head → unavailable, without a diff read', async () => {
    const host = fakeHost({ versions: [version(1, 'b'.repeat(40), '2026-10-01T10:00:00Z')] });
    expect(await resolveReviewedVersion(host, REF, IID, H)).toEqual({ kind: 'unavailable' });
    expect(host.calls.map((c) => c.kind)).toEqual(['list']);
  });

  it('truncated list without a match → unavailable (NFR page bound)', async () => {
    const host = fakeHost({ versions: [version(1, 'b'.repeat(40), '2026-10-01T10:00:00Z')], truncated: true });
    expect(await resolveReviewedVersion(host, REF, IID, H)).toEqual({ kind: 'unavailable' });
  });

  it.each([
    ['list', { listError: new AppError('gitlab_comment_failed', 'boom', 502) }],
    ['diff', { filesError: new AppError('gitlab_comment_failed', 'boom', 502) }],
    ['list (non-AppError)', { listError: new Error('socket hang up') }],
    ['diff (unknown code)', { filesError: { code: 'something_else' } }],
  ])('transient / unknown failure on the %s read → unavailable', async (_label, errs) => {
    const host = fakeHost({ versions: [version(1, H, '2026-10-01T10:00:00Z')], ...errs });
    expect(await resolveReviewedVersion(host, REF, IID, H)).toEqual({ kind: 'unavailable' });
  });

  it.each(['gitlab_token_invalid', 'gitlab_token_insufficient_scope', 'gitlab_project_inaccessible'] as const)(
    '%s on either read → fatal with that code; the log carries the code only',
    async (code) => {
      const logged: unknown[] = [];
      const log: PublishLogger = { warn: (o) => logged.push(o), error: (o) => logged.push(o) };
      const err = new AppError(code, 'secret upstream detail', 403);
      const onList = await resolveReviewedVersion(fakeHost({ listError: err }), REF, IID, H, log);
      expect(onList).toEqual({ kind: 'fatal', code });
      const onDiff = await resolveReviewedVersion(
        fakeHost({ versions: [version(1, H, '2026-10-01T10:00:00Z')], filesError: err }),
        REF,
        IID,
        H,
        log,
      );
      expect(onDiff).toEqual({ kind: 'fatal', code });
      expect(logged).toEqual([
        { step: 'list_versions', code },
        { step: 'version_diff', code },
      ]);
      expect(JSON.stringify(logged)).not.toContain('secret upstream detail');
    },
  );
});

describe('planAnchors — general sources (AC-8, AC-9)', () => {
  const findings = [finding('a', 2, 3), finding('b', 9, 4, 'src/other.ts')];

  it('none → every finding general review_head_unknown, 0 host calls', () => {
    const host = fakeHost({});
    const plan = planAnchors(findings, { kind: 'none' });
    expect(plan.get('a')).toMatchObject({ kind: 'general', offDiffReason: 'review_head_unknown', startLine: 2, endLine: 3 });
    expect(plan.get('b')).toMatchObject({ kind: 'general', offDiffReason: 'review_head_unknown', startLine: 4, endLine: 9 });
    expect(host.calls).toEqual([]);
    expect(countPlacement(plan)).toEqual({ positioned: 0, general: 2 });
  });

  it('unavailable → every finding general reviewed_version_unavailable', () => {
    const plan = planAnchors(findings, { kind: 'unavailable' });
    expect([...plan.values()].map((a) => a.kind === 'general' && a.offDiffReason)).toEqual([
      'reviewed_version_unavailable',
      'reviewed_version_unavailable',
    ]);
  });

  it('fatal → no plan', () => {
    expect(planAnchors(findings, { kind: 'fatal', code: 'gitlab_token_invalid' }).size).toBe(0);
  });
});
