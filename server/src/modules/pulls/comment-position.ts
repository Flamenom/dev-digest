/**
 * Pure: resolve a (path, side, line) comment target against the PERSISTED PR
 * diff into a GitLab text-position anchor (spec AC-9 – AC-11). No I/O.
 *
 * A small local hunk walker on purpose — `adapters/git/diff-parser.ts` is an
 * outer-ring module and must not be imported from the application ring.
 */

/** The persisted file fields this needs (structural — `PersistedFile` satisfies it). */
export interface PersistedFileLike {
  path: string;
  patch: string | null;
  previousPath: string | null;
  patchOmitted: string | null;
}

/** Where a comment lands: both paths, and only the line numbers that apply (AC-9/10). */
export interface GitLabTarget {
  oldPath: string;
  newPath: string;
  oldLine: number | null;
  newLine: number | null;
}

type LineKind = 'add' | 'del' | 'ctx';

interface DiffLine {
  kind: LineKind;
  oldLine: number | null;
  newLine: number | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Walks every hunk of a unified-diff patch; lines before the first header are ignored. */
function walkPatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let inHunk = false;
  for (const rawLine of patch.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldNo = Number(header[1]);
      oldLeft = header[2] != null ? Number(header[2]) : 1;
      newNo = Number(header[3]);
      newLeft = header[4] != null ? Number(header[4]) : 1;
      inHunk = true;
      continue;
    }
    if (!inHunk || (oldLeft <= 0 && newLeft <= 0)) continue;
    const marker = line[0];
    if (marker === '\\') continue; // "\ No newline at end of file"
    if (marker === '+') {
      out.push({ kind: 'add', oldLine: null, newLine: newNo });
      newNo += 1;
      newLeft -= 1;
    } else if (marker === '-') {
      out.push({ kind: 'del', oldLine: oldNo, newLine: null });
      oldNo += 1;
      oldLeft -= 1;
    } else if (marker === ' ' || line === '') {
      // Context (some tools strip the leading space of an empty context line).
      out.push({ kind: 'ctx', oldLine: oldNo, newLine: newNo });
      oldNo += 1;
      newNo += 1;
      oldLeft -= 1;
      newLeft -= 1;
    }
  }
  return out;
}

/**
 * The GitLab anchor for `side`@`line` of `path`, or null when that is not a
 * line of the persisted diff (AC-11): the file is absent, its patch was withheld
 * by the host (null / omitted), the line is outside every hunk, `LEFT` on an
 * added-only line (e.g. an added file) or `RIGHT` on a removed-only line (e.g.
 * a deleted file).
 *
 * - RIGHT on an added line → new line only; on a context line → both (AC-9).
 * - LEFT on a removed line → old line only; on a context line → both (AC-9).
 * - `oldPath` is the previous path of a renamed file, else `path` (AC-10).
 */
export function resolveGitLabTarget(
  files: readonly PersistedFileLike[],
  path: string,
  side: 'LEFT' | 'RIGHT' | undefined,
  line: number,
): GitLabTarget | null {
  const file = files.find((f) => f.path === path);
  if (!file || file.patch == null || file.patch === '') return null;
  if (file.patchOmitted != null && file.patchOmitted !== '') return null;

  const effectiveSide = side ?? 'RIGHT';
  const hit = walkPatch(file.patch).find((l) =>
    effectiveSide === 'RIGHT'
      ? l.newLine === line && l.kind !== 'del'
      : l.oldLine === line && l.kind !== 'add',
  );
  if (!hit) return null;

  return {
    oldPath: file.previousPath ?? file.path,
    newPath: file.path,
    oldLine: hit.oldLine,
    newLine: hit.newLine,
  };
}
