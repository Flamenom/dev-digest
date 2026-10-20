/**
 * resolveGitLabTarget — comment target vs the persisted diff (spec AC-9 – AC-11).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveGitLabTarget,
  type PersistedFileLike,
} from '../src/modules/pulls/comment-position.js';

// old: 1 a / 2 b / 3 c / 4 d        new: 1 a / 2 B / 3 c / 4 d / 5 e
const MODIFIED = [
  '@@ -1,4 +1,5 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  ' d',
  '+e',
].join('\n');

const files: PersistedFileLike[] = [
  { path: 'src/mod.ts', patch: MODIFIED, previousPath: null, patchOmitted: null },
  {
    path: 'src/new-name.ts',
    patch: '@@ -10,2 +10,2 @@\n ctx\n-old\n+new\n',
    previousPath: 'src/old-name.ts',
    patchOmitted: null,
  },
  { path: 'src/added.ts', patch: '@@ -0,0 +1,2 @@\n+one\n+two\n', previousPath: null, patchOmitted: null },
  { path: 'src/deleted.ts', patch: '@@ -1,2 +0,0 @@\n-one\n-two\n', previousPath: null, patchOmitted: null },
  { path: 'src/huge.ts', patch: null, previousPath: null, patchOmitted: 'too_large' },
  { path: 'src/binary.png', patch: null, previousPath: null, patchOmitted: null },
];

describe('resolveGitLabTarget', () => {
  it('anchors context / added / removed lines (AC-9)', () => {
    // Context line "c": old 3, new 3 — either side sends both.
    expect(resolveGitLabTarget(files, 'src/mod.ts', 'RIGHT', 3)).toEqual({
      oldPath: 'src/mod.ts',
      newPath: 'src/mod.ts',
      oldLine: 3,
      newLine: 3,
    });
    expect(resolveGitLabTarget(files, 'src/mod.ts', 'LEFT', 4)).toMatchObject({ oldLine: 4, newLine: 4 });
    // Added line "B": new 2 only.
    expect(resolveGitLabTarget(files, 'src/mod.ts', 'RIGHT', 2)).toMatchObject({ oldLine: null, newLine: 2 });
    // Removed line "b": old 2 only.
    expect(resolveGitLabTarget(files, 'src/mod.ts', 'LEFT', 2)).toMatchObject({ oldLine: 2, newLine: null });
    // Side defaults to RIGHT.
    expect(resolveGitLabTarget(files, 'src/mod.ts', undefined, 5)).toMatchObject({ oldLine: null, newLine: 5 });
  });

  it('sends the previous path of a renamed file (AC-10)', () => {
    const t = resolveGitLabTarget(files, 'src/new-name.ts', 'RIGHT', 11);
    expect(t).toEqual({ oldPath: 'src/old-name.ts', newPath: 'src/new-name.ts', oldLine: null, newLine: 11 });
    expect(t!.oldPath).not.toBe(t!.newPath);
  });

  it('rejects targets outside the persisted diff (AC-11, 5 cases)', () => {
    // 1. file absent
    expect(resolveGitLabTarget(files, 'src/missing.ts', 'RIGHT', 1)).toBeNull();
    // 2. patch withheld by the host (omitted / null)
    expect(resolveGitLabTarget(files, 'src/huge.ts', 'RIGHT', 1)).toBeNull();
    expect(resolveGitLabTarget(files, 'src/binary.png', 'RIGHT', 1)).toBeNull();
    // 3. line outside every hunk
    expect(resolveGitLabTarget(files, 'src/mod.ts', 'RIGHT', 40)).toBeNull();
    expect(resolveGitLabTarget(files, 'src/new-name.ts', 'RIGHT', 3)).toBeNull();
    // 4. LEFT on an added file
    expect(resolveGitLabTarget(files, 'src/added.ts', 'LEFT', 1)).toBeNull();
    expect(resolveGitLabTarget(files, 'src/added.ts', 'RIGHT', 1)).toMatchObject({ newLine: 1 });
    // 5. RIGHT on a deleted file
    expect(resolveGitLabTarget(files, 'src/deleted.ts', 'RIGHT', 1)).toBeNull();
    expect(resolveGitLabTarget(files, 'src/deleted.ts', 'LEFT', 1)).toMatchObject({ oldLine: 1 });
  });

  it('walks multiple hunks and ignores the "no newline" marker', () => {
    const patch = [
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+B',
      '\\ No newline at end of file',
      '@@ -20,2 +20,3 @@',
      ' x',
      '+y',
      ' z',
    ].join('\r\n');
    const f: PersistedFileLike[] = [{ path: 'm.ts', patch, previousPath: null, patchOmitted: null }];
    expect(resolveGitLabTarget(f, 'm.ts', 'RIGHT', 21)).toMatchObject({ oldLine: null, newLine: 21 });
    expect(resolveGitLabTarget(f, 'm.ts', 'RIGHT', 22)).toMatchObject({ oldLine: 21, newLine: 22 });
    expect(resolveGitLabTarget(f, 'm.ts', 'RIGHT', 10)).toBeNull();
  });
});
