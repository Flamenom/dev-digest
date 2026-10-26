/**
 * Mention / reference / image guard for finding-derived text (spec
 * `specs/2026-10-21-gitlab-publish-findings.md`, AC-16; plan "Mention /
 * reference / image guard — decision"). Pure, no I/O.
 *
 * Applied to the title, rationale, suggestion prose and evidence — NEVER to the
 * user-written summary. Outside code it makes sure GitLab's reference filters
 * find nothing, while the rendered text stays what the model wrote:
 *
 * - Mention / cross-reference triggers get U+200B ZERO WIDTH SPACE right after
 *   the trigger character: `@\u200Ball`, `#\u200B12`, `!\u200B45`, `~\u200Blabel`, `%\u200Bmilestone`,
 *   `&\u200B7` (epic), `$\u200B3` (snippet), and hence `group/project#\u200B1`. HTML entities do
 *   NOT work (Banzai's filters run on decoded text nodes), and an entity that
 *   decodes to a trigger (`&#64;all`) gets the U+200B after the entity.
 * - Images: an unescaped `![` becomes `\![` (a literal `!` plus a normal,
 *   non-auto-loading link). Raw HTML media / raw-text block tags (`<img`,
 *   `<picture`, `<video`, `<audio`, `<iframe`, …) become `\<…` (text).
 *
 * Untouched: fenced code blocks (where the line heuristic and a CommonMark parse
 * agree — `agreedFencedLines`), inline code spans, link destinations
 * (`[x](https://a/b#c)`), and bare `http(s)://` / `ftp://` / `www.` URLs.
 * Indented code is NOT exempt — guarding it only adds invisible characters, the
 * safe direction. Idempotent: guarded tokens no longer match.
 *
 * Invariant (tests): removing every inserted U+200B and every inserted `\` gives
 * the input back (after `\r\n` → `\n`).
 */
import { agreedFencedLines } from '../_shared/gitlab-note-text.js';

const ZWSP = '\u200B';

/** What may follow each trigger character for GitLab to see a reference. */
const REF_START: Record<string, RegExp> = {
  '@': /[\p{L}\p{N}_.]/u,
  '#': /\d/,
  '!': /\d/,
  '&': /\d/,
  '$': /\d/,
  '~': /[\p{L}\p{N}_"]/u,
  '%': /[\p{L}\p{N}_"]/u,
};

/** Entity spellings of the trigger characters (decoded by GitLab before its filters). */
const NAMED_TRIGGER: Record<string, string> = {
  commat: '@',
  num: '#',
  excl: '!',
  amp: '&',
  dollar: '$',
  percnt: '%',
};

/** `&name;`, `&#123;`, `&#x7B;` at the start of the string. */
const ENTITY = /^&(?:#[xX]([0-9a-fA-F]{1,6})|#(\d{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/;

/** Raw HTML tags that load media, embed content, or open a raw-text HTML block. */
const HTML_TAG =
  /^<(?:img|image|picture|source|video|audio|track|iframe|frame|object|embed|svg|pre|script|style|textarea)(?=[\s/>]|$)/i;

/** A bare URL GitLab autolinks (its text is inside a link, so no reference fires). */
const BARE_URL = /^(?:(?:https?|ftp):\/\/|www\.)[^\s<>]*/i;

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

function entityChar(entity: RegExpExecArray): string | null {
  const [, hex, dec, name] = entity;
  if (name) return NAMED_TRIGGER[name] ?? null;
  const code = hex ? parseInt(hex, 16) : parseInt(dec!, 10);
  if (!Number.isFinite(code) || code > 0x10ffff) return null;
  return String.fromCodePoint(code);
}

/** Whether `ch` (a trigger) followed by `next` would start a reference. */
/** The full code point at `i` (so an astral letter after a trigger is seen whole). */
function cpAt(s: string, i: number): string | undefined {
  const cp = s.codePointAt(i);
  return cp == null ? undefined : String.fromCodePoint(cp);
}

function startsReference(ch: string, next: string | undefined): boolean {
  const re = REF_START[ch];
  return re != null && next != null && re.test(next);
}

/**
 * End index (exclusive) of an inline link destination starting at `i` (just
 * after `](`), or -1 when it is not a well-formed destination.
 */
function linkDestinationEnd(s: string, i: number): number {
  if (s[i] === '<') {
    for (let j = i + 1; j < s.length; j++) {
      const c = s[j]!;
      if (c === '\n' || c === '<') return -1;
      if (c === '\\') {
        j++;
        continue;
      }
      if (c === '>') return j + 1;
    }
    return -1;
  }
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j]!;
    if (c === '\\' && j + 1 < s.length && ASCII_PUNCT.test(s[j + 1]!)) {
      j++;
      continue;
    }
    if (/\s/.test(c)) return depth === 0 ? j : -1;
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) return j;
      depth--;
    }
  }
  return depth === 0 ? s.length : -1;
}

/** Length of the backtick run at `i`. */
function backtickRun(s: string, i: number): number {
  let j = i;
  while (s[j] === '`') j++;
  return j - i;
}

/** Index of the next backtick run of exactly `len` after `from`, or -1. */
function closingRun(s: string, from: number, len: number): number {
  for (let j = from; j < s.length; ) {
    if (s[j] !== '`') {
      j++;
      continue;
    }
    const run = backtickRun(s, j);
    if (run === len) return j;
    j += run;
  }
  return -1;
}

/** Guards one paragraph-like segment of non-code lines (no blank line inside). */
function guardSegment(s: string): string {
  let out = '';
  let openBrackets = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;

    // Backslash escape: the escaped char is literal, but an escaped trigger still
    // decodes to a text node that the reference filters see.
    if (c === '\\' && i + 1 < s.length && ASCII_PUNCT.test(s[i + 1]!)) {
      const e = s[i + 1]!;
      out += c + e;
      if (startsReference(e, cpAt(s, i + 2))) out += ZWSP;
      i += 2;
      continue;
    }

    // Inline code span: copied verbatim when it has a matching closer.
    if (c === '`') {
      const run = backtickRun(s, i);
      const close = closingRun(s, i + run, run);
      if (close >= 0) {
        out += s.slice(i, close + run);
        i = close + run;
      } else {
        out += s.slice(i, i + run);
        i += run;
      }
      continue;
    }

    // Bare URL (at a word start): copied verbatim.
    if ((i === 0 || !/[\p{L}\p{N}_]/u.test(s[i - 1]!)) && /[hfwHFW]/.test(c)) {
      const url = BARE_URL.exec(s.slice(i, i + 4096));
      if (url && url[0].length > 0) {
        out += url[0];
        i += url[0].length;
        continue;
      }
    }

    // Link destination after `](`, only when a `[` is open.
    if (c === ']' && s[i + 1] === '(' && openBrackets > 0) {
      openBrackets--;
      const end = linkDestinationEnd(s, i + 2);
      if (end >= 0) {
        out += s.slice(i, end);
        i = end;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (c === '[') openBrackets++;
    else if (c === ']' && openBrackets > 0) openBrackets--;

    // Image syntax → literal `!` plus a link.
    if (c === '!' && s[i + 1] === '[') {
      out += '\\!';
      i++;
      continue;
    }

    // Raw HTML media / raw-text tags → text.
    if (c === '<' && HTML_TAG.test(s.slice(i, i + 16))) {
      out += '\\<';
      i++;
      continue;
    }

    // HTML entity: copied whole; U+200B after it when it decodes to a trigger.
    if (c === '&') {
      const ent = ENTITY.exec(s.slice(i, i + 40));
      if (ent) {
        out += ent[0];
        i += ent[0].length;
        const decoded = entityChar(ent);
        if (decoded != null && startsReference(decoded, cpAt(s, i))) out += ZWSP;
        continue;
      }
    }

    out += c;
    if (startsReference(c, cpAt(s, i + 1))) out += ZWSP;
    i++;
  }
  return out;
}

/** AC-16 guard for finding-derived Markdown. Code-aware and idempotent. */
export function guardFindingText(text: string): string {
  const normalised = text.replace(/\r\n?/g, '\n');
  const lines = normalised.split('\n');
  const code = agreedFencedLines(normalised);
  const out: string[] = [];
  let segment: string[] = [];
  const flush = (): void => {
    if (segment.length > 0) out.push(guardSegment(segment.join('\n')));
    segment = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (code.has(i)) {
      flush();
      out.push(line);
    } else if (line.trim() === '') {
      // A blank line ends a paragraph: code spans and links never cross it.
      flush();
      out.push(line);
    } else {
      segment.push(line);
    }
  }
  flush();
  return out.join('\n');
}
