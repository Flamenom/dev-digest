/**
 * Pure text transforms for comments posted to GitLab (spec
 * `specs/2026-10-20-gitlab-comments.md`, AC-7, AC-13, AC-16 – AC-18). No I/O.
 *
 * Length is always measured in UTF-16 code units (`String.prototype.length`),
 * the same unit the AC-15 limit check in `comments-service.ts` uses.
 */

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
 * Makes sure GitLab's quick-action extractor finds no command in `body`, while
 * the rendered text stays exactly what the user typed (AC-13).
 *
 * Technique (plan "Quick-action neutralisation — decision"): on every line
 * OUTSIDE a fenced code block whose first non-blank character is `/` (after 0–3
 * spaces or a run of Unicode spaces/zero-width chars), insert a backslash before
 * that `/`. GitLab's extractor matches `^\/<cmd>` on raw lines, so `\/` never
 * matches; CommonMark renders `\/` (escaped ASCII punctuation) as `/`.
 *
 * - Fenced blocks (``` / ~~~, length ≥ 3, 0–3 leading spaces) are byte-identical;
 *   a fence closes only on the same character with a run at least as long; an
 *   unclosed fence runs to the end of the text (as GitLab treats it).
 * - Lines indented ≥ 4 spaces or with a tab are untouched (indented code, where a
 *   backslash would show, or a continuation the raw-line regex cannot match).
 * - `\r` is preserved (lines split on `\n` only), so CRLF input stays CRLF.
 */
export function neutraliseQuickActions(body: string): string {
  const lines = body.split('\n');
  let fence: OpenFence | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    // Classify on the line without a trailing CR; edit the raw line.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const opener = fenceOpener(line);
    if (opener) {
      fence = opener;
      continue;
    }
    const m = SLASH_LINE.exec(raw);
    if (m) {
      const prefix = m[1]!;
      lines[i] = `${prefix}\\${raw.slice(prefix.length)}`;
    }
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
