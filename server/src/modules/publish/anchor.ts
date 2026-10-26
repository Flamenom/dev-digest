/**
 * Pure: plan where each finding's GitLab note lands (spec AC-9 – AC-11, AC-13,
 * AC-25). No I/O.
 *
 * Anchors are decided against a GitLab MR diff — the persisted one (`pr_files`)
 * or, for an outdated run, the reviewed MR diff version (outdated-findings
 * AC-6, via `anchor-source.ts`) — never the review's local diff (AC-9). New-side lines = added (`+`) and
 * context (` `) lines; removed (`-`) lines have no new-side number.
 *
 * A small local hunk walker on purpose (plan Rec4): `pulls/comment-position.ts`
 * is a sibling module, and `adapters/git/diff-parser.ts` is an outer ring.
 */
import type { OffDiffReasonAll, PublishAnchorWithDeprecation, Severity } from '@devdigest/shared';
import type { PersistedFileLike } from './ports.js';

// ---------- Types ----------

/** One new-side line of the persisted diff. */
export interface NewSideLine {
  kind: 'added' | 'context';
  /** Old-side number for a context line; null for an added line. */
  oldLine: number | null;
  /** 0-based index of the hunk the line belongs to. */
  hunk: number;
}

export type NewSideIndex =
  | { unavailable: true }
  | { unavailable: false; lines: ReadonlyMap<number, NewSideLine> };

/** Both line numbers of a diff line, in the port's `line_range` shape. */
export interface DiffLineRef {
  oldLine: number | null;
  newLine: number;
}

interface PositionedAnchorBase {
  path: string;
  /** The previous path of a renamed file, else `path` (comments AC-10). */
  oldPath: string;
  /** The finding's normalised range: `min(start,end)` / `max(start,end)`. */
  startLine: number;
  endLine: number;
  /** The new-side line the note is positioned on. */
  anchorLine: number;
  /** Old-side number of `anchorLine` (context line) or null (added line). */
  anchorOldLine: number | null;
  /** Every line of `startLine..endLine` is an added line (AC-17). */
  allAdded: boolean;
  /** `anchorLine` is an added line. */
  anchorIsAdded: boolean;
}

/** `start < end`, every line new-side in one hunk: anchored at `end` with a `line_range` (AC-11). */
export interface MultiLineAnchor extends PositionedAnchorBase {
  kind: 'multi_line';
  rangeStart: DiffLineRef;
  rangeEnd: DiffLineRef;
}

export interface SingleLineAnchor extends PositionedAnchorBase {
  kind: 'single_line';
}

/**
 * No new-side line in range, or the patch is unavailable: an unpositioned
 * (general) note carrying its location as text (AC-9, AC-10). `allAdded` /
 * `anchorIsAdded` are always false so every variant has the same flag fields.
 */
export interface GeneralAnchor {
  kind: 'general';
  path: string;
  startLine: number;
  endLine: number;
  offDiffReason: OffDiffReasonAll;
  allAdded: false;
  anchorIsAdded: false;
}

export type PlannedAnchor = MultiLineAnchor | SingleLineAnchor | GeneralAnchor;

/** The finding fields anchoring needs (the `Finding` contract's names). */
export interface AnchorableFinding {
  file: string;
  start_line: number;
  end_line: number;
}

// ---------- Hunk walk ----------

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Index the new-side lines of a persisted file's patch. `patch == null` or a
 * withheld patch (`patchOmitted`) → `{ unavailable: true }` (AC-10). Lines
 * before the first hunk header and `\ No newline at end of file` are skipped.
 */
export function buildNewSideIndex(file: PersistedFileLike): NewSideIndex {
  if (file.patch == null) return { unavailable: true };
  if (file.patchOmitted != null && file.patchOmitted !== '') return { unavailable: true };

  const lines = new Map<number, NewSideLine>();
  let hunk = -1;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const rawLine of file.patch.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const header = HUNK_HEADER.exec(line);
    if (header) {
      hunk += 1;
      oldNo = Number(header[1]);
      oldLeft = header[2] != null ? Number(header[2]) : 1;
      newNo = Number(header[3]);
      newLeft = header[4] != null ? Number(header[4]) : 1;
      continue;
    }
    if (hunk < 0 || (oldLeft <= 0 && newLeft <= 0)) continue;
    const marker = line[0];
    if (marker === '\\') continue; // "\ No newline at end of file"
    if (marker === '+') {
      lines.set(newNo, { kind: 'added', oldLine: null, hunk });
      newNo += 1;
      newLeft -= 1;
    } else if (marker === '-') {
      oldNo += 1;
      oldLeft -= 1;
    } else if (marker === ' ' || line === '') {
      // Context (some tools strip the leading space of an empty context line).
      lines.set(newNo, { kind: 'context', oldLine: oldNo, hunk });
      oldNo += 1;
      newNo += 1;
      oldLeft -= 1;
      newLeft -= 1;
    }
  }
  return { unavailable: false, lines };
}

// ---------- Resolution ----------

function general(
  path: string,
  startLine: number,
  endLine: number,
  offDiffReason: OffDiffReasonAll,
): GeneralAnchor {
  return { kind: 'general', path, startLine, endLine, offDiffReason, allAdded: false, anchorIsAdded: false };
}

/**
 * Plan the anchor of one finding against the persisted MR diff (AC-9 – AC-11):
 * - file absent or deleted → general `not_on_diff_line`;
 * - patch unavailable → general `patch_unavailable`;
 * - no new-side line in `[lo, hi]` → general `not_on_diff_line`;
 * - `lo < hi` and every line `lo..hi` new-side in one hunk → multi-line at `hi`;
 * - else single line at `hi` if new-side, else the in-range new-side line
 *   closest to `hi` (tie → lower).
 */
export function resolveAnchor(
  finding: AnchorableFinding,
  files: readonly PersistedFileLike[],
): PlannedAnchor {
  const lo = Math.min(finding.start_line, finding.end_line);
  const hi = Math.max(finding.start_line, finding.end_line);
  const path = finding.file;

  const file = files.find((f) => f.path === path);
  if (!file || file.changeType === 'deleted') return general(path, lo, hi, 'not_on_diff_line');

  const index = buildNewSideIndex(file);
  if (index.unavailable) return general(path, lo, hi, 'patch_unavailable');

  // Walk the index, not `lo..hi`: full-file ranges (secret_leak …) can be huge.
  const inRange: [number, NewSideLine][] = [];
  for (const entry of index.lines) {
    if (entry[0] >= lo && entry[0] <= hi) inRange.push(entry);
  }
  if (inRange.length === 0) return general(path, lo, hi, 'not_on_diff_line');

  const span = hi - lo + 1;
  const everyLineNewSide = inRange.length === span;
  const allAdded = everyLineNewSide && inRange.every(([, l]) => l.kind === 'added');
  const oldPath = file.previousPath ?? file.path;
  const lines = index.lines;

  const sameHunk = inRange.every(([, l]) => l.hunk === inRange[0]![1].hunk);
  if (lo < hi && everyLineNewSide && sameHunk) {
    const start = lines.get(lo)!;
    const end = lines.get(hi)!;
    return {
      kind: 'multi_line',
      path,
      oldPath,
      startLine: lo,
      endLine: hi,
      anchorLine: hi,
      anchorOldLine: end.oldLine,
      allAdded,
      anchorIsAdded: end.kind === 'added',
      rangeStart: { oldLine: start.oldLine, newLine: lo },
      rangeEnd: { oldLine: end.oldLine, newLine: hi },
    };
  }

  let best = inRange[0]!;
  for (const entry of inRange) {
    const d = Math.abs(hi - entry[0]);
    const bestD = Math.abs(hi - best[0]);
    if (d < bestD || (d === bestD && entry[0] < best[0])) best = entry;
  }
  const [anchorLine, anchorInfo] = best;
  return {
    kind: 'single_line',
    path,
    oldPath,
    startLine: lo,
    endLine: hi,
    anchorLine,
    anchorOldLine: anchorInfo.oldLine,
    allAdded,
    anchorIsAdded: anchorInfo.kind === 'added',
  };
}

/**
 * AC-13: a multi-line anchor GitLab rejected with a 400 → the single-line
 * anchor at `end` (every line of a multi-line range is new-side, so `end` is).
 * The finding range (`startLine..endLine`) is kept, so the AC-17 eligibility
 * check then sees a lost range and downgrades a suggestion. Other kinds are
 * returned unchanged.
 */
export function singleLineFallback(anchor: PlannedAnchor): PlannedAnchor {
  if (anchor.kind !== 'multi_line') return anchor;
  return {
    kind: 'single_line',
    path: anchor.path,
    oldPath: anchor.oldPath,
    startLine: anchor.startLine,
    endLine: anchor.endLine,
    anchorLine: anchor.rangeEnd.newLine,
    anchorOldLine: anchor.rangeEnd.oldLine,
    allAdded: anchor.allAdded,
    anchorIsAdded: anchor.anchorIsAdded,
  };
}

/**
 * A general (unpositioned) anchor over the finding's normalised range. Used
 * for `review_head_unknown`, `reviewed_version_unavailable`, `position_rejected`
 * and as the AC-18 worst-case bound anchor of a deferred finding.
 */
export function generalAnchor(finding: AnchorableFinding, reason: OffDiffReasonAll): GeneralAnchor {
  const lo = Math.min(finding.start_line, finding.end_line);
  const hi = Math.max(finding.start_line, finding.end_line);
  return general(finding.file, lo, hi, reason);
}

/**
 * Preview anchor of a finding whose placement is decided at publish, against
 * the reviewed MR diff version (outdated-findings AC-19). Not a `PlannedAnchor`
 * variant: "deferred" is a preview / item state, not a placement.
 */
export function deferredPublishAnchor(finding: AnchorableFinding): PublishAnchorWithDeprecation {
  return {
    kind: 'deferred',
    path: finding.file,
    start_line: Math.min(finding.start_line, finding.end_line),
    end_line: Math.max(finding.start_line, finding.end_line),
    off_diff_reason: null,
  };
}

/** The contract projection of a planned anchor (preview `anchor`, AC-2). */
export function toPublishAnchor(anchor: PlannedAnchor): PublishAnchorWithDeprecation {
  return {
    kind: anchor.kind,
    path: anchor.path,
    start_line: anchor.startLine,
    end_line: anchor.endLine,
    off_diff_reason: anchor.kind === 'general' ? anchor.offDiffReason : null,
  };
}

// ---------- Send order ----------

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  CRITICAL: 0,
  WARNING: 1,
  SUGGESTION: 2,
};

export interface SortableFinding {
  id: string;
  severity: Severity;
  file: string;
  start_line: number;
  end_line: number;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Send order (AC-25): severity (CRITICAL, WARNING, SUGGESTION), then file,
 * then (normalised) start line, then finding id for a stable total order.
 * Code-unit string comparison, so the order does not depend on the locale.
 */
export function compareForSend(a: SortableFinding, b: SortableFinding): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    cmp(a.file, b.file) ||
    Math.min(a.start_line, a.end_line) - Math.min(b.start_line, b.end_line) ||
    cmp(a.id, b.id)
  );
}
