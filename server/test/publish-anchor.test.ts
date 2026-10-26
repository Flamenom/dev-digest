/**
 * Publish anchor planning vs the persisted MR diff (spec AC-9 – AC-11, AC-13, AC-25).
 */
import { describe, it, expect } from 'vitest';
import {
  buildNewSideIndex,
  compareForSend,
  deferredPublishAnchor,
  generalAnchor,
  resolveAnchor,
  singleLineFallback,
  toPublishAnchor,
  type SortableFinding,
} from '../src/modules/publish/anchor.js';
import type { PersistedFileLike } from '../src/modules/publish/ports.js';

// Hunk 0: old 1 a / 2 b / 3 c / 4 d          new 1 a / 2 B / 3 B2 / 4 c / 5 d
// Hunk 1: old 20 x / 21 q / 22 w             new 21 x / 22 y / 23 z / 24 w
const PATCH = [
  '@@ -1,4 +1,5 @@ function head()',
  ' a',
  '-b',
  '+B',
  '+B2',
  ' c',
  '', // empty context line with its leading space stripped (new 5 / old 4)
  '@@ -20,3 +21,4 @@',
  ' x',
  '+y',
  '+z',
  '-q',
  ' w',
  '\\ No newline at end of file',
  '',
].join('\n');

const file = (over: Partial<PersistedFileLike> = {}): PersistedFileLike => ({
  path: 'src/a.ts',
  patch: PATCH,
  previousPath: null,
  patchOmitted: null,
  changeType: 'modified',
  ...over,
});

const FILES: PersistedFileLike[] = [
  file(),
  file({ path: 'src/gone.ts', changeType: 'deleted', patch: '@@ -1,2 +0,0 @@\n-x\n-y\n' }),
  file({ path: 'src/big.ts', patch: null, patchOmitted: 'too_large' }),
  file({ path: 'src/withheld.ts', patch: null }),
  file({ path: 'src/new-name.ts', previousPath: 'src/old-name.ts', changeType: 'renamed' }),
];

const at = (start_line: number, end_line: number, f = 'src/a.ts') => ({ file: f, start_line, end_line });

describe('buildNewSideIndex', () => {
  it('indexes added + context lines per hunk and skips removed / no-newline lines', () => {
    const idx = buildNewSideIndex(file());
    expect(idx.unavailable).toBe(false);
    if (idx.unavailable) return;
    expect([...idx.lines.keys()]).toEqual([1, 2, 3, 4, 5, 21, 22, 23, 24]);
    expect(idx.lines.get(1)).toEqual({ kind: 'context', oldLine: 1, hunk: 0 });
    expect(idx.lines.get(2)).toEqual({ kind: 'added', oldLine: null, hunk: 0 });
    expect(idx.lines.get(5)).toEqual({ kind: 'context', oldLine: 4, hunk: 0 });
    expect(idx.lines.get(24)).toEqual({ kind: 'context', oldLine: 22, hunk: 1 });
  });

  it('is unavailable for a null or withheld patch (AC-10)', () => {
    expect(buildNewSideIndex(file({ patch: null }))).toEqual({ unavailable: true });
    expect(buildNewSideIndex(file({ patchOmitted: 'too_large' }))).toEqual({ unavailable: true });
  });
});

describe('resolveAnchor — general (AC-9, AC-10)', () => {
  it.each([
    ['file absent from the MR diff', at(1, 3, 'src/not-in-diff.ts')],
    ['deleted file', at(1, 2, 'src/gone.ts')],
    ['range between hunks', at(8, 15)],
    ['range after the last hunk', at(30, 40)],
    ['secret_leak full-file range outside the diff', at(40, 4000)],
    ['phantom outside the diff', at(10, 12)],
  ])('%s → general not_on_diff_line', (_label, finding) => {
    const a = resolveAnchor(finding, FILES);
    expect(a).toEqual({
      kind: 'general',
      path: finding.file,
      startLine: finding.start_line,
      endLine: finding.end_line,
      offDiffReason: 'not_on_diff_line',
      allAdded: false,
      anchorIsAdded: false,
    });
    expect(toPublishAnchor(a).off_diff_reason).toBe('not_on_diff_line');
  });

  it.each([
    ['patch_omitted too_large', 'src/big.ts'],
    ['patch null', 'src/withheld.ts'],
  ])('%s → general patch_unavailable', (_label, path) => {
    const a = resolveAnchor(at(1, 2, path), FILES);
    expect(a.kind).toBe('general');
    expect(a.kind === 'general' && a.offDiffReason).toBe('patch_unavailable');
  });
});

describe('resolveAnchor — positioned (AC-11)', () => {
  it('contiguous added range → multi_line start..end anchored at end', () => {
    expect(resolveAnchor(at(2, 3), FILES)).toEqual({
      kind: 'multi_line',
      path: 'src/a.ts',
      oldPath: 'src/a.ts',
      startLine: 2,
      endLine: 3,
      anchorLine: 3,
      anchorOldLine: null,
      allAdded: true,
      anchorIsAdded: true,
      rangeStart: { oldLine: null, newLine: 2 },
      rangeEnd: { oldLine: null, newLine: 3 },
    });
  });

  it('a range with context lines in one hunk is multi_line; context ends carry old + new', () => {
    const a = resolveAnchor(at(1, 4), FILES);
    expect(a.kind).toBe('multi_line');
    if (a.kind !== 'multi_line') return;
    expect(a.rangeStart).toEqual({ oldLine: 1, newLine: 1 });
    expect(a.rangeEnd).toEqual({ oldLine: 3, newLine: 4 });
    expect(a.anchorOldLine).toBe(3);
    expect(a.allAdded).toBe(false);
    expect(a.anchorIsAdded).toBe(false);
  });

  it('range spanning two hunks → single_line at the nearest-to-end new-side line', () => {
    const a = resolveAnchor(at(3, 22), FILES);
    expect(a).toMatchObject({ kind: 'single_line', anchorLine: 22, anchorOldLine: null, anchorIsAdded: true });
    expect(a).toMatchObject({ startLine: 3, endLine: 22, allAdded: false });
  });

  it('end on an unchanged line outside the hunk → nearest in-range new-side line (context: old + new)', () => {
    const a = resolveAnchor(at(4, 10), FILES);
    expect(a).toMatchObject({ kind: 'single_line', anchorLine: 5, anchorOldLine: 4, anchorIsAdded: false });
    const b = resolveAnchor(at(22, 30), FILES);
    expect(b).toMatchObject({ kind: 'single_line', anchorLine: 24, anchorOldLine: 22 });
  });

  it('a range that only partly touches a hunk is still positioned (AC-9 last clause)', () => {
    expect(resolveAnchor(at(5, 9), FILES)).toMatchObject({ kind: 'single_line', anchorLine: 5 });
    expect(resolveAnchor(at(15, 21), FILES)).toMatchObject({ kind: 'single_line', anchorLine: 21 });
  });

  it('single added line → single_line, allAdded', () => {
    expect(resolveAnchor(at(23, 23), FILES)).toMatchObject({
      kind: 'single_line',
      startLine: 23,
      endLine: 23,
      anchorLine: 23,
      allAdded: true,
      anchorIsAdded: true,
    });
  });

  it('start > end is normalised', () => {
    expect(resolveAnchor(at(3, 2), FILES)).toMatchObject({ kind: 'multi_line', startLine: 2, endLine: 3 });
    expect(resolveAnchor(at(15, 8), FILES)).toMatchObject({ kind: 'general', startLine: 8, endLine: 15 });
  });

  it('a renamed file sends its previous path as the old path', () => {
    const a = resolveAnchor(at(2, 2, 'src/new-name.ts'), FILES);
    expect(a).toMatchObject({ kind: 'single_line', path: 'src/new-name.ts', oldPath: 'src/old-name.ts' });
  });
});

describe('singleLineFallback (AC-13)', () => {
  it('turns a multi-line anchor into a single line at end, keeping the finding range', () => {
    const multi = resolveAnchor(at(1, 4), FILES);
    expect(singleLineFallback(multi)).toEqual({
      kind: 'single_line',
      path: 'src/a.ts',
      oldPath: 'src/a.ts',
      startLine: 1,
      endLine: 4,
      anchorLine: 4,
      anchorOldLine: 3,
      allAdded: false,
      anchorIsAdded: false,
    });
  });

  it('leaves single-line and general anchors unchanged', () => {
    const single = resolveAnchor(at(23, 23), FILES);
    const gen = resolveAnchor(at(8, 9), FILES);
    expect(singleLineFallback(single)).toBe(single);
    expect(singleLineFallback(gen)).toBe(gen);
  });
});

describe('toPublishAnchor', () => {
  it('projects to the contract shape', () => {
    expect(toPublishAnchor(resolveAnchor(at(2, 3), FILES))).toEqual({
      kind: 'multi_line',
      path: 'src/a.ts',
      start_line: 2,
      end_line: 3,
      off_diff_reason: null,
    });
  });
});

describe('compareForSend (AC-25)', () => {
  it('orders by severity, then file, then line, then id', () => {
    const f = (id: string, severity: SortableFinding['severity'], file: string, line: number): SortableFinding => ({
      id,
      severity,
      file,
      start_line: line,
      end_line: line,
    });
    const input = [
      f('s1', 'SUGGESTION', 'a.ts', 1),
      f('w2', 'WARNING', 'b.ts', 1),
      f('c3', 'CRITICAL', 'z.ts', 9),
      f('w1', 'WARNING', 'a.ts', 20),
      f('w0', 'WARNING', 'a.ts', 3),
      f('c2', 'CRITICAL', 'a.ts', 5),
      f('c1', 'CRITICAL', 'a.ts', 5),
    ];
    expect([...input].sort(compareForSend).map((x) => x.id)).toEqual([
      'c1',
      'c2',
      'c3',
      'w0',
      'w1',
      'w2',
      's1',
    ]);
  });

  it('uses the normalised start line', () => {
    const a: SortableFinding = { id: 'a', severity: 'WARNING', file: 'x', start_line: 10, end_line: 2 };
    const b: SortableFinding = { id: 'b', severity: 'WARNING', file: 'x', start_line: 5, end_line: 5 };
    expect([b, a].sort(compareForSend).map((x) => x.id)).toEqual(['a', 'b']);
  });
});

describe('generalAnchor / deferredPublishAnchor (outdated-findings AC-8, AC-9, AC-12, AC-19)', () => {
  it.each(['review_head_unknown', 'reviewed_version_unavailable', 'position_rejected'] as const)(
    'generalAnchor(%s) is a general anchor over the normalised range',
    (reason) => {
      const a = generalAnchor(at(9, 4), reason);
      expect(a).toEqual({
        kind: 'general',
        path: 'src/a.ts',
        startLine: 4,
        endLine: 9,
        offDiffReason: reason,
        allAdded: false,
        anchorIsAdded: false,
      });
      expect(toPublishAnchor(a)).toEqual({
        kind: 'general',
        path: 'src/a.ts',
        start_line: 4,
        end_line: 9,
        off_diff_reason: reason,
      });
    },
  );

  it('deferredPublishAnchor carries path + normalised lines and no off-diff reason', () => {
    expect(deferredPublishAnchor(at(12, 3))).toEqual({
      kind: 'deferred',
      path: 'src/a.ts',
      start_line: 3,
      end_line: 12,
      off_diff_reason: null,
    });
  });
});
