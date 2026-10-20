/**
 * Pure comment-body transforms (spec `specs/2026-10-20-gitlab-comments.md`):
 * quick-action neutralisation (AC-13), attribution footer (AC-16 – AC-18) and
 * footer stripping on read (AC-7).
 *
 * AC-13 security property (`rawCommandLines`, test/helpers/fake-gitlab.ts): no
 * output line is command-shaped — checked on raw lines, independent of any
 * Markdown parser, over fixtures plus a deterministic fuzz corpus of GLFM
 * containers / fences / line endings. Secondary check: the oracle
 * (`quickActionMatches`) models GitLab's extractor: delete `\r` → CommonMark
 * parse → top-level paragraphs' source lines (+1 trailing blank line) → the
 * extractor's command regex. It is conservative (never reports fewer commands than GitLab). GitLab's real Banzai
 * renderer and its render of `\/` are not reproducible offline — those are
 * covered by the manual sandbox smoke recorded in the PR description.
 */
import { Parser } from 'commonmark';
import { describe, it, expect } from 'vitest';
import {
  composeGitLabText,
  footerFor,
  neutraliseQuickActions,
  sanitiseFooterName,
  stripAttribution,
} from '../src/modules/pulls/comment-body.js';
import { quickActionMatches, rawCommandLines } from './helpers/fake-gitlab.js';

/** The neutraliser's line-ending normalisation: CRLF → LF, then lone CR → LF. */
const lf = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const ZWSP = '​';
const UNICODE_LEAD = '  -​  　﻿';
/** Command-shaped line (mirrors the neutraliser's detector); group 1 = lead. */
const COMMAND_SHAPED = new RegExp(
  `^( {0,3}(?:[${UNICODE_LEAD}][ ${UNICODE_LEAD}]*)?)/[\\p{L}\\p{N}_][\\p{L}\\p{M}\\p{N}_]*(?=\\s|$)`,
  'u',
);

/** Line heuristic: per-line flag "inside / opening / closing a top-level ``` or ~~~ fence". */
function heuristicFenced(text: string): boolean[] {
  const flags: boolean[] = [];
  let open: { char: string; len: number } | null = null;
  for (const line of text.split('\n')) {
    if (open) {
      flags.push(true);
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (m && m[1]![0] === open.char && m[1]!.length >= open.len) open = null;
      continue;
    }
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (m && !(m[1]![0] === '`' && m[2]!.includes('`'))) {
      open = { char: m[1]![0]!, len: m[1]!.length };
      flags.push(true);
      continue;
    }
    flags.push(false);
  }
  return flags;
}

/** 0-based indexes of lines inside a CommonMark code block (any depth). */
function commonmarkCode(text: string): Set<number> {
  const code = new Set<number>();
  const walker = new Parser().parse(text).walker();
  for (let ev = walker.next(); ev; ev = walker.next()) {
    if (!ev.entering || ev.node.type !== 'code_block') continue;
    for (let l = ev.node.sourcepos[0][0]; l <= ev.node.sourcepos[1][0]; l++) code.add(l - 1);
  }
  return code;
}

/** Lines BOTH parsers place inside a code block — the only ones given the invisible U+200B. */
function agreedCode(text: string): Set<number> {
  const fenced = heuristicFenced(text);
  return new Set([...commonmarkCode(text)].filter((i) => fenced[i]));
}

/** Removes exactly the inserted `\` / U+200B: one char before the `/` of a line that is then command-shaped. */
function restore(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const m = new RegExp(`^( {0,3}(?:[${UNICODE_LEAD}][ ${UNICODE_LEAD}]*)?)[\\\\${ZWSP}](/.*)$`, 'u').exec(line);
      if (!m) return line;
      const candidate = m[1]! + m[2]!;
      return COMMAND_SHAPED.test(candidate) ? candidate : line;
    })
    .join('\n');
}

const FIXTURES: Record<string, string> = {
  spec: '/merge\n/close\nLGTM',
  crlf: '/merge\r\n/close\r\nLGTM\r\n',
  uppercase: '/MERGE\n/Close now',
  leadingSpaces: ' /merge\n  /approve\n   /label ~bug',
  tab: '\t/merge',
  fourSpaces: '    /merge',
  listItem: '- /merge',
  blockquote: '> /merge',
  midLine: 'please /merge this',
  unicodeLead: ' /merge\n​/close\n　 /approve\n﻿/shrug',
  backtickFence: 'before\n```\n/merge\n```\n/close',
  tildeFence: '~~~sh\n/merge\n~~~\n/close after',
  longFence: '````\n/merge\n```\n/still inside\n````\n/label x',
  mixedFenceChars: '```\n/merge\n~~~\n/inside\n```\n/outside',
  unclosedFence: 'text\n```\n/merge\n/close',
  indentedFence: '   ```\n/merge\n   ```\n/close',
  fenceInListItem: '- item\n\n  ```\n  /merge\n  ```\n\n/close',
  crlfFence: '```\r\n/merge\r\n```\r\n/close\r\n',
  // CR-only line endings: GitLab (deleting \r) would see `LGTM/merge/close`, but
  // CommonMark — and GitLab's renderer — treat each CR as a line break.
  crOnlyEndings: 'LGTM\r\r/merge\r/close',
  withArgs: '/assign @alice\n/label ~bug ~p1\n/spend 1h',
  blankLines: '\n\n/merge\n\n',
  alreadyEscaped: '\\/merge',
  // Not command-shaped: paths, comments — never touched, even outside code.
  paths: '/usr/bin/env node\n/* block */\n// line\n/path/to/file\n/',
  codePaths: '```\n/usr/bin/env\n/close\n```',
  // Ruby's case-insensitive match folds these to ASCII command names.
  unicodeFold: '/cloſe\n/Kick\n/ﬁx',
  trailingTab: '/close\t',
};

/**
 * Inputs that bypassed an earlier neutraliser (its output still executed a
 * command) and close variants: a `\r` GitLab deletes, a fence-looking line inside
 * an HTML block / quote / list, a `\r` splitting a closing fence, and GLFM
 * containers (comrak) that the CommonMark parse does not model.
 */
const BYPASSES: Record<string, string> = {
  crBeforeSlash: 'x\n\r/merge',
  crCrBeforeSlash: 'x\n\r\r/merge',
  crMixedEndings: 'a\r\n\r/merge\rb\n\r\n/close',
  htmlBacktickFence: '<div>\n```\n\n/merge\n',
  htmlTildeFence: '<div>\n~~~\n\n/merge\n',
  crInClosingFence: '```\nfoo\n`\r``\n/merge',
  details: '<details>\n```\n\n/merge\n</details>',
  htmlComment: '<!--\n```\n-->\n\n/merge',
  htmlCommentFenceInside: '<!-- x\n~~~ -->\n/merge',
  pre: '<pre>\n```\n</pre>\n\n/merge',
  htmlThenBlank: '<div>\n```\n</div>\n\n/close\n/merge',
  blockquoteFence: '> ```\n/merge',
  listFence: '- ```\n/merge',
  // comrak + GLFM `multiline_block_quotes`: `>>>` closes the quote, so the
  // fence inside it never shields `/close` (verified executing with comrak).
  glfmMultilineQuote: '>>>\n~~~\n>>>\n/close',
  // comrak + GLFM `description_lists`: the fence belongs to the definition.
  glfmDescriptionList: 'Term\n: def\n   ~~~\n\n/close',
};

const ALL = { ...FIXTURES, ...BYPASSES };

// ---------- fuzz corpus (deterministic) ----------

/** GLFM / CommonMark containers and code constructs that may re-shape what is "code". */
const BLOCKS = [
  '>>>', '>>> [!NOTE]', '> [!NOTE]', '```', '~~~', '````', '```math', '~~~ `', '``` ~', '   ```', '\t```',
  '$$', '| a |\n|---|', '| a |', 'Term\n: def', ': def', '   ~~~', '[^1]: x', '[^1]:', '<div>', '</div>',
  '<pre>', '</pre>', '<!--', '-->', '<details>', '</details>', '<script>', '<textarea>', '<?', '<![CDATA[',
  '---', '+++', '* * *', 'para', '', '    x', '- item', '> q', '1. x', '- [ ] task', '[x]: /url', '\\',
  ':::', '::: note', 'a\n===', ' >>>', '>>> ', '>>>>', '```\n```',
];
const COMMANDS = [
  '/close', '/merge', ' /close', '   /label ~x', '/label ~x ~y', '/MERGE', '/submit_review', '/assign @a',
  '/close\t', '/cloſe', '/Kill', ' /close', '​/close', '/new_command arg', '/_x',
];
const SEPARATORS = ['\n', '\n', '\n', '\r\n', '\r'];

/** mulberry32 — a tiny seeded PRNG so the fuzz corpus is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fuzzCorpus(): string[] {
  const out: string[] = [];
  // Exhaustive: every ordered block pair followed by a command line.
  for (const a of BLOCKS) for (const b of BLOCKS) out.push(`${a}\n${b}\n/close`);
  // Random: 2–9 parts from blocks + commands, random line endings.
  const rnd = prng(0xc0ffee);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  for (let n = 0; n < 4000; n++) {
    const parts: string[] = [];
    const len = 2 + Math.floor(rnd() * 8);
    for (let k = 0; k < len; k++) parts.push(rnd() < 0.4 ? pick(COMMANDS) : pick(BLOCKS));
    let body = '';
    parts.forEach((p, k) => {
      body += (k === 0 ? '' : pick(SEPARATORS)) + p.replace(/\n/g, pick(SEPARATORS));
    });
    out.push(body);
  }
  return out;
}

const FUZZ = fuzzCorpus();

describe('neutraliseQuickActions (AC-13)', () => {
  it('turns the spec example into escaped slashes', () => {
    expect(neutraliseQuickActions('/merge\n/close\nLGTM')).toBe('\\/merge\n\\/close\nLGTM');
  });

  it('SECURITY: no output line is command-shaped, for every fixture and the fuzz corpus', () => {
    const inputs = [...Object.values(ALL), ...FUZZ];
    expect(FUZZ.length).toBeGreaterThan(6000);
    let rawCommands = 0;
    for (const input of inputs) {
      if (rawCommandLines(lf(input)).length > 0) rawCommands++;
      const out = neutraliseQuickActions(input);
      expect(rawCommandLines(out), JSON.stringify(input)).toEqual([]);
      expect(out, JSON.stringify(input)).not.toContain('\r');
    }
    // Sanity: the corpus is not vacuous — most inputs carry a command line.
    expect(rawCommands).toBeGreaterThan(inputs.length / 2);
  });

  it('blocks the comrak (GLFM) bypasses of the both-parsers-agree neutraliser', () => {
    const n = neutraliseQuickActions;
    for (const name of ['glfmMultilineQuote', 'glfmDescriptionList'] as const) {
      expect(rawCommandLines(BYPASSES[name]!), name).toEqual(['/close']);
    }
    // CommonMark sees code here (both guesses agree), so the mark is the invisible
    // U+200B — GitLab renders a paragraph, but `^\/` can no longer match.
    expect(n(BYPASSES.glfmMultilineQuote!)).toBe(`>>>\n~~~\n>>>\n${ZWSP}/close`);
    expect(n(BYPASSES.glfmDescriptionList!)).toBe(`Term\n: def\n   ~~~\n\n${ZWSP}/close`);
  });

  it('the oracle sees commands in raw input (sanity) but none after neutralising (secondary check)', () => {
    expect(quickActionMatches(FIXTURES.spec!)).toEqual(['merge', 'close']);
    expect(quickActionMatches(FIXTURES.crlf!)).toEqual(['merge', 'close']);
    expect(quickActionMatches(FIXTURES.uppercase!)).toEqual(['MERGE', 'Close']);
    for (const [name, input] of Object.entries(BYPASSES)) {
      if (name.startsWith('glfm')) continue; // comrak-only; the CommonMark oracle cannot see them
      expect(quickActionMatches(input).length, `${name}: raw input runs a command`).toBeGreaterThan(0);
    }
    for (const input of [...Object.values(ALL), ...FUZZ]) {
      expect(quickActionMatches(neutraliseQuickActions(input)), JSON.stringify(input)).toEqual([]);
    }
  });

  it('marks command-shaped lines only (U+200B in agreed code, `\\` elsewhere) and is reversible', () => {
    for (const [name, input] of [...Object.entries(ALL), ...FUZZ.map((f, i) => [`fuzz#${i}`, f] as const)]) {
      const normalised = lf(input);
      const out = neutraliseQuickActions(input);
      const inLines = normalised.split('\n');
      const outLines = out.split('\n');
      expect(outLines.length, name).toBe(inLines.length);
      const agreed = agreedCode(normalised);
      inLines.forEach((line, i) => {
        const m = COMMAND_SHAPED.exec(line);
        if (!m) {
          expect(outLines[i], `${name} line ${i}`).toBe(line);
          return;
        }
        const lead = m[1]!;
        const mark = agreed.has(i) ? ZWSP : '\\';
        expect(outLines[i], `${name} line ${i}`).toBe(`${lead}${mark}${line.slice(lead.length)}`);
      });
      // `alreadyEscaped` is returned unchanged (asserted below); the restore helper
      // would also strip the user's own backslash, so it is skipped here.
      if (name !== 'alreadyEscaped') expect(restore(out), name).toBe(normalised);
    }
  });

  it('exact outputs: fences get the invisible mark, everything else `\\/`', () => {
    const n = neutraliseQuickActions;
    expect(n(FIXTURES.backtickFence!)).toBe(`before\n\`\`\`\n${ZWSP}/merge\n\`\`\`\n\\/close`);
    expect(n(FIXTURES.unclosedFence!)).toBe(`text\n\`\`\`\n${ZWSP}/merge\n${ZWSP}/close`);
    expect(n(FIXTURES.longFence!)).toBe(
      `\`\`\`\`\n${ZWSP}/merge\n\`\`\`\n${ZWSP}/still inside\n\`\`\`\`\n\\/label x`,
    );
    expect(n(FIXTURES.fenceInListItem!)).toBe(`- item\n\n  \`\`\`\n  ${ZWSP}/merge\n  \`\`\`\n\n\\/close`);
    expect(n(FIXTURES.leadingSpaces!)).toBe(' \\/merge\n  \\/approve\n   \\/label ~bug');
    // CRLF is not preserved: line endings are normalised to LF before marking, so
    // the text sent is exactly the text analysed (GitLab deletes `\r` itself).
    expect(n(FIXTURES.crlf!)).toBe('\\/merge\n\\/close\nLGTM\n');
    expect(n(FIXTURES.crlfFence!)).toBe(`\`\`\`\n${ZWSP}/merge\n\`\`\`\n\\/close\n`);
    expect(n(' /merge')).toBe(' \\/merge');
    expect(n(BYPASSES.crBeforeSlash!)).toBe('x\n\n\\/merge');
    expect(n(BYPASSES.crCrBeforeSlash!)).toBe('x\n\n\n\\/merge');
    expect(n(FIXTURES.crOnlyEndings!)).toBe('LGTM\n\n\\/merge\n\\/close');
    expect(n(BYPASSES.htmlBacktickFence!)).toBe('<div>\n```\n\n\\/merge\n');
    expect(n(BYPASSES.htmlTildeFence!)).toBe('<div>\n~~~\n\n\\/merge\n');
    // The CR becomes a line break: `/merge` is inside the unclosed fence on both sides.
    expect(n(BYPASSES.crInClosingFence!)).toBe(`\`\`\`\nfoo\n\`\n\`\`\n${ZWSP}/merge`);
    expect(n(BYPASSES.details!)).toBe('<details>\n```\n\n\\/merge\n</details>');
    expect(n(BYPASSES.pre!)).toBe('<pre>\n```\n</pre>\n\n\\/merge');
    // A fence-looking line inside a quote/list is not a top-level fence: backslash.
    expect(n(BYPASSES.blockquoteFence!)).toBe('> ```\n\\/merge');
    expect(n(BYPASSES.listFence!)).toBe('- ```\n\\/merge');
    expect(n(FIXTURES.codePaths!)).toBe(`\`\`\`\n/usr/bin/env\n${ZWSP}/close\n\`\`\``);
    expect(n(FIXTURES.unicodeFold!)).toBe('\\/cloſe\n\\/Kick\n\\/ﬁx');
    expect(n(FIXTURES.unicodeLead!)).toBe(' \\/merge\n​\\/close\n　 \\/approve\n﻿\\/shrug');
    // Untouched: tab / 4-space indent, list, quote, mid-line, already escaped, paths.
    for (const key of ['tab', 'fourSpaces', 'listItem', 'blockquote', 'midLine', 'alreadyEscaped', 'paths']) {
      expect(n(FIXTURES[key]!), key).toBe(FIXTURES[key]);
    }
  });

  it('falls back to `\\/` everywhere when the CommonMark parse is skipped', () => {
    // A > 64-char container prefix trips the parse guard: nothing counts as code,
    // so fenced command lines get the backslash too (still safe).
    const deep = `${'- '.repeat(40)}x\n\`\`\`\n/merge\n\`\`\``;
    expect(neutraliseQuickActions(deep)).toBe(`${'- '.repeat(40)}x\n\`\`\`\n\\/merge\n\`\`\``);
  });
});

describe('attribution footer (AC-16 – AC-18)', () => {
  it('composes the exact footer', () => {
    expect(composeGitLabText('Nit', 'Jane Doe')).toBe('Nit\n\n— posted by `Jane Doe` via DevDigest');
    expect(footerFor('x')).toBe('\n\n— posted by `x` via DevDigest');
    expect(composeGitLabText('Nit', null)).toBe('Nit');
  });

  it('neutralises the body before appending the footer', () => {
    expect(composeGitLabText('/merge', 'Jane')).toBe('\\/merge\n\n— posted by `Jane` via DevDigest');
  });

  it('sanitises the name so no line starts with / and the code span holds', () => {
    const name = sanitiseFooterName('@all\n/merge', null);
    expect(name).toBe('@all /merge');
    const text = composeGitLabText('ok', name);
    expect(text).toContain('`@all /merge`');
    expect(text.split('\n').some((l) => l.startsWith('/'))).toBe(false);
    expect(sanitiseFooterName('a`b\u0007c\u200Bd\u2028e  \t f', null)).toBe('abcd e f');
  });

  it('truncates to 100 and falls back', () => {
    expect(sanitiseFooterName('x'.repeat(500), null)).toBe('x'.repeat(100));
    expect(sanitiseFooterName('', null)).toBe('a DevDigest user');
    expect(sanitiseFooterName('  \n ``', '')).toBe('a DevDigest user');
    expect(sanitiseFooterName(null, 'jane@example.com')).toBe('jane@example.com');
    expect(sanitiseFooterName('   ', 'jane@example.com')).toBe('jane@example.com');
  });
});

describe('stripAttribution (AC-7)', () => {
  const posted = composeGitLabText('Looks good', 'Jane Doe');

  it('strips the exact trailing footer for the service account only', () => {
    expect(stripAttribution(posted, true)).toEqual({ body: 'Looks good', attribution: { name: 'Jane Doe' } });
    expect(stripAttribution(posted, false)).toEqual({ body: posted, attribution: null });
  });

  it('leaves inexact footers alone', () => {
    expect(stripAttribution(`${posted}\n`, true).attribution).toBeNull();
    expect(stripAttribution('x\n\n- posted by `Jane` via DevDigest', true).attribution).toBeNull();
    expect(stripAttribution(`x${footerFor('y'.repeat(101))}`, true).attribution).toBeNull();
  });
});
