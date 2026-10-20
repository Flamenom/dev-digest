/**
 * Pure text transforms for comments posted to GitLab (spec
 * `specs/2026-10-20-gitlab-comments.md`, AC-7, AC-13, AC-16 – AC-18). No I/O.
 *
 * Length is always measured in UTF-16 code units (`String.prototype.length`),
 * the same unit the AC-15 limit check in `comments-service.ts` uses.
 */
import { Parser } from 'commonmark';

// ---------------------------------------------------------------------------
// Quick-action neutralisation (AC-13)
// ---------------------------------------------------------------------------

/**
 * Unicode spaces / zero-width characters that may precede a `/` without making
 * the line indented code: U+00A0, U+2000–U+200B, U+202F, U+205F, U+3000, U+FEFF.
 */
const UNICODE_LEAD = '\\u00A0\\u2000-\\u200B\\u202F\\u205F\\u3000\\uFEFF';

/**
 * A line whose first non-blank character is `/`: 0–3 ASCII spaces, optionally
 * followed by a run of Unicode spaces/zero-width chars (after which any further
 * spaces are fine — the line can no longer be indented code). Group 1 is the
 * prefix kept before the inserted backslash.
 */
const SLASH_LINE = new RegExp(`^( {0,3}(?:[${UNICODE_LEAD}][ ${UNICODE_LEAD}]*)?)/`);

/** CommonMark fence opener: 0–3 spaces, then ``` or ~~~ (≥ 3). */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Bodies longer than this skip the CommonMark parse (every `/`-leading line is
 * escaped). GitLab rejects notes above 1,000,000 characters, so such a post is
 * refused by the AC-15 length check anyway; the cap only bounds CPU.
 */
const PARSE_MAX_CHARS = 1_000_000;

/**
 * Container-prefix guard: if any line starts with more than this many
 * characters of whitespace / block-quote / list markers, the CommonMark parse is
 * skipped. commonmark.js's block parser is super-linear in container depth on a
 * single line (`- - - - …`); a deep prefix is never needed for real comments.
 * Skipping the parse is the SAFE direction — every `/`-leading line is escaped.
 */
const MAX_CONTAINER_PREFIX = 64;
const CONTAINER_PREFIX = /^(?:[ \t]|[>*+-](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))*/;

interface OpenFence {
  char: '`' | '~';
  length: number;
}

function fenceOpener(line: string): OpenFence | null {
  const m = FENCE_OPEN.exec(line);
  if (!m) return null;
  const run = m[1]!;
  const info = m[2] ?? '';
  const char = run[0] as '`' | '~';
  // A backtick fence's info string may not contain a backtick (CommonMark).
  if (char === '`' && info.includes('`')) return null;
  return { char, length: run.length };
}

function closesFence(line: string, open: OpenFence): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (!m) return false;
  const run = m[1]!;
  return run[0] === open.char && run.length >= open.length;
}

/**
 * Line heuristic: `true` for every line inside (or opening/closing) a top-level
 * fenced block. An unclosed fence runs to the end of the text.
 */
function heuristicFencedLines(lines: readonly string[]): boolean[] {
  const fenced = new Array<boolean>(lines.length).fill(false);
  let fence: OpenFence | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence) {
      fenced[i] = true;
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const opener = fenceOpener(line);
    if (opener) {
      fenced[i] = true;
      fence = opener;
    }
  }
  return fenced;
}

/**
 * Real CommonMark parse (block structure only — inline parsing is skipped, it
 * cannot change which lines belong to a code block): the 0-based indexes of every
 * line inside a code block (fenced or indented, at any nesting depth). Returns an
 * empty set when a guard trips, so nothing is treated as code.
 */
function commonmarkCodeLines(text: string, lines: readonly string[]): Set<number> {
  const code = new Set<number>();
  if (text.length > PARSE_MAX_CHARS) return code;
  for (const line of lines) {
    if (CONTAINER_PREFIX.exec(line)![0].length > MAX_CONTAINER_PREFIX) return code;
  }
  const parser = new Parser();
  // Block structure is all we need; inline parsing is skipped for cost.
  (parser as unknown as { processInlines: () => void }).processInlines = () => {};
  const walker = parser.parse(text).walker();
  for (let ev = walker.next(); ev; ev = walker.next()) {
    if (!ev.entering || ev.node.type !== 'code_block') continue;
    const [[startLine], [endLine]] = ev.node.sourcepos;
    for (let l = startLine; l <= endLine; l++) code.add(l - 1);
  }
  return code;
}

/**
 * Makes sure GitLab's quick-action extractor finds no command in `body`, while
 * the rendered text stays what the user typed (AC-13).
 *
 * GitLab's extractor (`lib/gitlab/quick_actions/extractor.rb`) deletes `\r`,
 * renders the text through Banzai, keeps only TOP-LEVEL paragraphs, and matches
 * `^\/<cmd>` on those paragraphs' raw source lines.
 *
 * Technique (plan "Quick-action neutralisation — decision"):
 * 1. Line endings are normalised first: `\r\n` → `\n`, then any lone `\r` →
 *    `\n` (CommonMark treats a bare CR as a line ending). CRLF is therefore NOT
 *    preserved: the text sent is exactly the text analysed here, so GitLab's own
 *    `\r` deletion can no longer re-shape lines behind our back (a leading `\r`
 *    hiding a `/`, or a `\r` splitting a closing fence).
 * 2. On every line whose first non-blank character is `/` (after 0–3 spaces or a
 *    run of Unicode spaces/zero-width chars), a backslash is inserted before that
 *    `/` — UNLESS the line lies inside a code block according to BOTH the line
 *    heuristic (top-level ``` / ~~~ fences) AND a real CommonMark parse
 *    (`commonmark`, with source positions). A bypass would need both parsers to
 *    be fooled identically. `\/` never matches `^\/`; CommonMark renders the
 *    escaped ASCII punctuation `\/` as `/`.
 *
 * - Genuine fenced blocks (both agree) are byte-identical (after step 1).
 *   Fence-looking lines inside HTML blocks, block quotes or lists are not
 *   top-level fences, so `/` lines there are escaped — over-escaping is safe.
 * - Lines indented ≥ 4 spaces or with a tab are untouched (indented code, where a
 *   backslash would show, or a continuation the raw-line regex cannot match).
 */
export function neutraliseQuickActions(body: string): string {
  const text = body.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const fenced = heuristicFencedLines(lines);
  const slash = lines.map((line) => SLASH_LINE.exec(line));
  // The parse only matters when the heuristic would keep some `/` line.
  const needsParse = slash.some((m, i) => m !== null && fenced[i]);
  const code = needsParse ? commonmarkCodeLines(text, lines) : new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const m = slash[i];
    if (!m || (fenced[i] && code.has(i))) continue;
    const prefix = m[1]!;
    lines[i] = `${prefix}\\${lines[i]!.slice(prefix.length)}`;
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Attribution footer (AC-16 – AC-18)
// ---------------------------------------------------------------------------

export const FOOTER_NAME_MAX = 100;
export const FOOTER_NAME_FALLBACK = 'a DevDigest user';

/**
 * Sanitises one candidate name: line breaks/tabs → space; other control and
 * format characters (\p{Cc}, \p{Cf}) and backticks removed; whitespace collapsed;
 * trimmed; truncated to 100 code points.
 */
function sanitiseOne(value: string | null | undefined): string {
  if (!value) return '';
  const cleaned = value
    .replace(/[\r\n\t\u2028\u2029\v\f]/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return Array.from(cleaned).slice(0, FOOTER_NAME_MAX).join('').trim();
}

/**
 * The footer name (AC-16, AC-18): the display name, or the email when the name
 * is empty, sanitised; "a DevDigest user" when both are empty after sanitising.
 * The result never contains a line break or a backtick, so the footer line can
 * neither start with `/` nor break out of its inline-code span.
 */
export function sanitiseFooterName(name: string | null, email: string | null): string {
  return sanitiseOne(name) || sanitiseOne(email) || FOOTER_NAME_FALLBACK;
}

/** `"\n\n— posted by `<name>` via DevDigest"` (— is U+2014). `name` must be sanitised. */
export function footerFor(name: string): string {
  return `\n\n— posted by \`${name}\` via DevDigest`;
}

/**
 * The exact text sent to GitLab: the neutralised body, plus the footer when a
 * (sanitised) footer name is given. The body is neutralised BEFORE the footer is
 * appended; the footer starts with `—`, so it never needs neutralising.
 */
export function composeGitLabText(body: string, footerName: string | null): string {
  const text = neutraliseQuickActions(body);
  return footerName == null ? text : text + footerFor(footerName);
}

/** An exact trailing AC-16 footer (end of string, no trailing whitespace). */
const FOOTER_SUFFIX = /\n\n— posted by `([^`\n]{1,100})` via DevDigest$/u;

/**
 * AC-7: for a note posted by the service account, split off an exact trailing
 * footer. A footer typed by anyone else (or an inexact one) is left in the body.
 */
export function stripAttribution(
  body: string,
  isServiceAccount: boolean,
): { body: string; attribution: { name: string } | null } {
  if (!isServiceAccount) return { body, attribution: null };
  const m = FOOTER_SUFFIX.exec(body);
  if (!m) return { body, attribution: null };
  return { body: body.slice(0, m.index), attribution: { name: m[1]! } };
}
