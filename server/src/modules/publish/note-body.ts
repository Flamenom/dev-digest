/**
 * Composes the GitLab note body for one published finding, and the review
 * summary (spec `specs/2026-10-21-gitlab-publish-findings.md`, AC-14 – AC-19,
 * AC-42). Pure, no I/O.
 *
 * Pipeline: finding-derived text → mention guard (AC-16) → assemble in AC-14
 * order with the marker → `neutraliseQuickActions` over everything (AC-15) →
 * footer appended last (google mode; it starts with `—`, never command-shaped,
 * and `stripAttribution` relies on it being the final line).
 *
 * Length is measured in UTF-16 code units, as in the comments spec (AC-15).
 *
 * Deprecated runs (spec `specs/2026-10-23-gitlab-publish-outdated-findings.md`,
 * AC-14 – AC-18): a deprecated line directly after the header, reason-specific
 * location-line suffixes, never an applicable suggestion, the deprecated line
 * at the top of the summary, and a worst-case overhead always counted in the
 * length bound. A non-deprecated body stays byte-identical to the base (AC-5).
 */
import type {
  DeprecationReason,
  FindingCategory,
  FindingKind,
  OffDiffReasonAll,
  Severity,
  TrifectaEvidence,
} from '@devdigest/shared';
import { PUBLISH_BODY_MAX_CHARS, PUBLISH_SUGGESTION_MAX_SPAN } from '@devdigest/shared';
import {
  FOOTER_NAME_MAX,
  footerFor,
  isCommandShapedLine,
  isFenceClose,
  neutraliseQuickActions,
  parseFenceOpener,
} from '../_shared/gitlab-note-text.js';
import { MARKER_LINE_LENGTH } from '../_shared/publish-marker.js';
import { guardFindingText } from './mention-guard.js';

/** The finding fields the composer reads. */
export interface NoteFinding {
  severity: Severity;
  category: FindingCategory;
  title: string;
  rationale: string;
  suggestion?: string | null;
  kind?: FindingKind | null;
  evidence?: readonly TrifectaEvidence[] | null;
}

/**
 * The planned anchor, declared structurally so this file does not depend on the
 * resolver (`anchor.ts`'s `PlannedAnchor` is assignable to it). `startLine` /
 * `endLine` are the normalised finding range (`startLine ≤ endLine`).
 */
export type NoteAnchor =
  | {
      kind: 'multi_line' | 'single_line';
      path: string;
      startLine: number;
      endLine: number;
      /** Every line of `startLine..endLine` is an added line. */
      allAdded: boolean;
      /** The anchor line itself is an added line. */
      anchorIsAdded: boolean;
    }
  | {
      kind: 'general';
      path: string;
      startLine: number;
      endLine: number;
      /** Picks the AC-15 location-line suffix on a deprecated run; ignored otherwise. */
      offDiffReason?: OffDiffReasonAll;
    };

/** A deprecated run (AC-14): why, and the review's `head_sha` (null when unknown). */
export interface NoteDeprecation {
  reason: DeprecationReason;
  reviewedHeadSha: string | null;
}

export interface ComposeFindingNoteInput {
  finding: NoteFinding;
  anchor: NoteAnchor;
  /** The confirm-dialog toggle "Make code suggestions applicable" (AC-17, AC-38). */
  applySuggestion: boolean;
  /** The marker line from `buildMarker` (AC-24). */
  marker: string;
  /** Sanitised footer name in google mode; null in local mode (AC-42). */
  footerName: string | null;
  /** Set for a deprecated run (AC-14 – AC-16); absent / null = base behaviour. */
  deprecation?: NoteDeprecation | null;
}

export interface ComposedNote {
  body: string;
  suggestionApplicable: boolean;
}

/** AC-19 fixed sentence for `secret_leak` findings. */
export const SECRET_LEAK_SENTENCE =
  'A possible secret was detected on this line. Rotate it and remove it from history.';

/**
 * AC-19 fixed header title for `secret_leak` findings — a finding's title often
 * quotes the credential, so no finding-provided text reaches GitLab.
 */
export const SECRET_LEAK_TITLE = 'Possible secret detected';

/** Q6: a lowercase-hex commit SHA; anything else falls back to the `head_unknown` wording. */
const HEX_SHA = /^[0-9a-f]{7,64}$/;

/** AC-14 `head_unknown` wording (also used when the SHA is not lowercase hex). */
export const DEPRECATED_LINE_HEAD_UNKNOWN =
  '⚠ Deprecated: the reviewed commit is unknown; the MR may have changed since.';

/**
 * The AC-14 deprecated line. `head_moved` with a lowercase-hex SHA shows its
 * first 8 characters in inline code (hex only, so it cannot carry a mention or
 * a quick action); otherwise the `head_unknown` wording.
 */
export function deprecatedLine(dep: NoteDeprecation): string {
  const sha = dep.reviewedHeadSha;
  if (dep.reason === 'head_moved' && sha != null && HEX_SHA.test(sha)) {
    return `⚠ Deprecated: reviewed at \`${sha.slice(0, 8)}\`; the MR has changed since.`;
  }
  return DEPRECATED_LINE_HEAD_UNKNOWN;
}

/** Base AC-14 item 2 suffix — a non-deprecated general note, byte for byte. */
const BASE_LOCATION_SUFFIX = '(not on a changed line of this MR)';

/** AC-15: the location-line suffix of a deprecated run's general note, per `off_diff_reason`. */
export const DEPRECATED_LOCATION_SUFFIX: Readonly<Record<OffDiffReasonAll, string>> = {
  not_on_diff_line: '(not on a changed line of the reviewed version)',
  patch_unavailable: "(the reviewed version's diff of this file is unavailable)",
  reviewed_version_unavailable: '(the reviewed version of the diff was not found on GitLab)',
  review_head_unknown: '(the reviewed commit is unknown)',
  position_rejected: '(GitLab could not place it on the reviewed version)',
};

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

/** One line: every line break / tab / Unicode separator run → one space; trimmed. */
function flatten(text: string): string {
  return text.replace(/[\s\u0085]+/gu, ' ').trim();
}

/** A path for an inline code span: backticks, line breaks and control chars removed. */
function codeSpanPath(path: string): string {
  return path.replace(/[\r\n\u0085\u2028\u2029]+/gu, ' ').replace(/[\p{Cc}`]/gu, '');
}

function longestBacktickRun(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return max;
}

/** A backtick fence longer than any backtick run in `code` (minimum 3). */
function fenceFor(code: string): string {
  return '`'.repeat(Math.max(3, longestBacktickRun(code) + 1));
}

interface FencedBlock {
  /** Index of the opener line. */
  open: number;
  /** Index of the closer line, or -1 when unclosed (runs to the end). */
  close: number;
  info: string;
  /** Content lines, with up to the opener's indent stripped (CommonMark). */
  code: string[];
}

interface Part {
  kind: 'prose' | 'code';
  text: string;
  info?: string;
}

/** Splits Markdown into prose runs and top-level fenced code blocks. */
function splitFenced(text: string): { parts: Part[]; blocks: FencedBlock[] } {
  const lines = text.split('\n');
  const parts: Part[] = [];
  const blocks: FencedBlock[] = [];
  let prose: string[] = [];
  const flushProse = (): void => {
    if (prose.length > 0) parts.push({ kind: 'prose', text: prose.join('\n') });
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const opener = parseFenceOpener(line);
    if (!opener) {
      prose.push(line);
      continue;
    }
    const indent = /^ */.exec(line)![0].length;
    const info = line.slice(indent + opener.length).trim();
    const code: string[] = [];
    let close = -1;
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (isFenceClose(lines[j]!, opener)) {
        close = j;
        break;
      }
      code.push(lines[j]!.replace(new RegExp(`^ {0,${indent}}`), ''));
    }
    flushProse();
    blocks.push({ open: i, close, info, code });
    parts.push({ kind: 'code', text: code.join('\n'), info });
    i = close === -1 ? lines.length : close;
  }
  flushProse();
  return { parts, blocks };
}

/** The single fenced block that IS the whole (trimmed) suggestion, or null. */
function soleFencedBlock(suggestion: string): FencedBlock | null {
  const trimmed = suggestion.replace(/\r\n?/g, '\n').trim();
  if (trimmed === '') return null;
  const { blocks, parts } = splitFenced(trimmed);
  if (blocks.length !== 1 || parts.length !== 1) return null;
  const block = blocks[0]!;
  const lastLine = trimmed.split('\n').length - 1;
  if (block.open !== 0 || block.close !== lastLine) return null;
  return block;
}

/** Re-fences a backtick-free-safe info string (a backtick fence's info may not hold a backtick). */
function safeInfo(info: string | undefined): string {
  return info && !info.includes('`') ? info : '';
}

/** Closes an unclosed fence at the end of guarded prose so it cannot swallow the marker. */
function closeDanglingFence(text: string): string {
  const { blocks } = splitFenced(text);
  const last = blocks[blocks.length - 1];
  if (!last || last.close !== -1) return text;
  const opener = parseFenceOpener(text.split('\n')[last.open]!)!;
  return `${text}\n${opener.char.repeat(opener.length)}`;
}

/** AC-17 plain rendering: guarded prose; every code block re-fenced, never broken out of. */
function renderPlainSuggestion(suggestion: string): string {
  const { parts } = splitFenced(suggestion.replace(/\r\n?/g, '\n').trim());
  return parts
    .map((p) => {
      if (p.kind === 'prose') return guardFindingText(p.text);
      const fence = fenceFor(p.text);
      return `${fence}${safeInfo(p.info)}\n${p.text}\n${fence}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// AC-17 eligibility
// ---------------------------------------------------------------------------

/**
 * Every AC-17 condition EXCEPT the confirm-dialog toggle — the preview's
 * `suggestion_eligible` flag.
 */
export function suggestionEligibility(
  finding: NoteFinding,
  anchor: NoteAnchor,
  deprecated = false,
): boolean {
  // AC-16: never applicable on a deprecated run.
  if (deprecated) return false;
  if (anchor.kind === 'general') return false;
  if (finding.kind != null && finding.kind !== 'finding') return false;
  if (finding.suggestion == null) return false;
  const span = anchor.endLine - anchor.startLine;
  if (span < 0 || span > PUBLISH_SUGGESTION_MAX_SPAN) return false;
  if (anchor.kind === 'single_line' && !(span === 0 && anchor.anchorIsAdded)) return false;
  if (!anchor.allAdded) return false;
  const block = soleFencedBlock(finding.suggestion);
  if (!block) return false;
  return !block.code.some(isCommandShapedLine);
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

function headerLine(finding: NoteFinding): string {
  const title = finding.kind === 'secret_leak' ? SECRET_LEAK_TITLE : guardFindingText(flatten(finding.title));
  return `**${finding.severity}** · ${finding.category} · ${title}`;
}

function locationLineWith(path: string, startLine: number, endLine: number, suffix: string): string {
  const range = startLine === endLine ? `${startLine}` : `${startLine}–${endLine}`;
  return `📍 \`${codeSpanPath(path)}:${range}\` ${suffix}`;
}

function locationLine(anchor: NoteAnchor & { kind: 'general' }, deprecated: boolean): string {
  const suffix = deprecated
    ? DEPRECATED_LOCATION_SUFFIX[anchor.offDiffReason ?? 'not_on_diff_line']
    : BASE_LOCATION_SUFFIX;
  return locationLineWith(anchor.path, anchor.startLine, anchor.endLine, suffix);
}

/** Header line, then (deprecated) the deprecated line, then (general) the location line. */
function headBlock(finding: NoteFinding, anchor: NoteAnchor, deprecation: NoteDeprecation | null): string {
  const lines = [headerLine(finding)];
  if (deprecation != null) lines.push(deprecatedLine(deprecation));
  if (anchor.kind === 'general') lines.push(locationLine(anchor, deprecation != null));
  return lines.join('\n');
}

function finish(blocks: string[], footerName: string | null): string {
  const text = neutraliseQuickActions(blocks.join('\n\n'));
  return footerName == null ? text : text + footerFor(footerName);
}

/** The AC-14 note body (AC-19 redacted form for `secret_leak`). */
export function composeFindingNote(input: ComposeFindingNoteInput): ComposedNote {
  const { finding, anchor, marker, footerName } = input;
  const deprecation = input.deprecation ?? null;
  const head = headBlock(finding, anchor, deprecation);

  if (finding.kind === 'secret_leak') {
    // AC-19: the title (fixed header text), rationale, suggestion and evidence are never read.
    return { body: finish([head, SECRET_LEAK_SENTENCE, marker], footerName), suggestionApplicable: false };
  }

  const blocks: string[] = [head];
  const rationale = finding.rationale.replace(/\r\n?/g, '\n').trim();
  if (rationale !== '') blocks.push(closeDanglingFence(guardFindingText(rationale)));

  let suggestionApplicable = false;
  const suggestion = finding.suggestion?.trim() ? finding.suggestion : null;
  if (suggestion != null) {
    const applicable = input.applySuggestion && suggestionEligibility(finding, anchor, deprecation != null);
    let rendered: string;
    if (applicable) {
      const code = soleFencedBlock(suggestion)!.code.join('\n');
      const fence = fenceFor(code);
      const n = anchor.endLine - anchor.startLine;
      rendered = `${fence}suggestion:-${n}+0\n${code}\n${fence}`;
      suggestionApplicable = true;
    } else {
      rendered = renderPlainSuggestion(suggestion);
    }
    blocks.push(`**Suggestion**\n\n${rendered}`);
  }

  if (finding.kind === 'lethal_trifecta' && finding.evidence && finding.evidence.length > 0) {
    const items = finding.evidence.map((e) => `- ${e.component} \`${codeSpanPath(e.file)}:${e.line}\``);
    blocks.push(`**Evidence**\n\n${items.join('\n')}`);
  }

  blocks.push(marker);
  return { body: finish(blocks, footerName), suggestionApplicable };
}

/**
 * AC-13 re-send after a 400 on a multi-line draft: the note for a single-line
 * anchor at `end`. A suggestion that depended on the range (span > 0) is
 * downgraded to a plain block. A deprecated run never applies one (AC-16 —
 * enforced in `composeFindingNote`).
 */
export function downgradeForSingleLine(input: ComposeFindingNoteInput): ComposedNote {
  const { anchor } = input;
  const ranged = anchor.endLine > anchor.startLine;
  return composeFindingNote({ ...input, applySuggestion: input.applySuggestion && !ranged });
}

/**
 * The review summary for `bulk_publish`: neutralised (no mention guard, AC-16) +
 * footer. A deprecated run's summary begins with the deprecated line and a blank
 * line (new-spec AC-17).
 */
export function composeSummary(
  summary: string,
  footerName: string | null,
  deprecation?: NoteDeprecation | null,
): string {
  const full = deprecation != null ? `${deprecatedLine(deprecation)}\n\n${summary}` : summary;
  const text = neutraliseQuickActions(full);
  return footerName == null ? text : text + footerFor(footerName);
}

/** Worst-case footer name: 100 code points, each astral (2 UTF-16 units). */
const WORST_FOOTER_NAME = '\u{1D400}'.repeat(FOOTER_NAME_MAX);
const PLACEHOLDER_MARKER = '<'.padEnd(MARKER_LINE_LENGTH, 'x');

/** The longest AC-14 deprecated line (the 8-char `head_moved` or the `head_unknown` wording). */
const LONGEST_DEPRECATED_LINE = Math.max(
  deprecatedLine({ reason: 'head_moved', reviewedHeadSha: 'f'.repeat(40) }).length,
  DEPRECATED_LINE_HEAD_UNKNOWN.length,
);

const ALL_LOCATION_SUFFIXES = [BASE_LOCATION_SUFFIX, ...Object.values(DEPRECATED_LOCATION_SUFFIX)];

/**
 * AC-18 worst-case overhead for a finding at `path:start–end`: the longest
 * deprecated line + 1 newline + the longest location line (under the longest
 * suffix) + 1 newline. Charged to every anchor, positioned ones included, so
 * the preview and the publish can never disagree about `body_too_long`.
 */
export function generalOverheadFor(path: string, startLine: number, endLine: number): number {
  const longestLocation = Math.max(
    ...ALL_LOCATION_SUFFIXES.map((s) => locationLineWith(path, startLine, endLine, s).length),
  );
  return LONGEST_DEPRECATED_LINE + 1 + longestLocation + 1;
}

/**
 * An upper bound (UTF-16 units) of the composed body, whatever the toggle,
 * marker ids, footer name or deprecation — for the AC-18 preview / validation
 * check. The base composition plus the worst-case deprecated overhead.
 */
export function noteLengthUpperBound(finding: NoteFinding, anchor: NoteAnchor): number {
  const base = { finding, anchor, marker: PLACEHOLDER_MARKER, footerName: WORST_FOOTER_NAME };
  const overhead = generalOverheadFor(anchor.path, anchor.startLine, anchor.endLine);
  const plain = composeFindingNote({ ...base, applySuggestion: false }).body.length;
  if (!suggestionEligibility(finding, anchor)) return plain + overhead;
  return Math.max(plain, composeFindingNote({ ...base, applySuggestion: true }).body.length) + overhead;
}

/** AC-18: whether the composed body may exceed GitLab's note limit. */
export function isBodyTooLong(finding: NoteFinding, anchor: NoteAnchor): boolean {
  return noteLengthUpperBound(finding, anchor) > PUBLISH_BODY_MAX_CHARS;
}
