/**
 * Pure comment-body transforms (spec `specs/2026-10-20-gitlab-comments.md`):
 * quick-action neutralisation (AC-13), attribution footer (AC-16 – AC-18) and
 * footer stripping on read (AC-7).
 *
 * The AC-13 oracle (`quickActionMatches`, test/helpers/fake-gitlab.ts) models
 * GitLab's extractor: delete `\r` → CommonMark parse → top-level paragraphs'
 * source lines (+1 trailing blank line) → the extractor's command regex. It is
 * conservative (never reports fewer commands than GitLab). GitLab's real Banzai
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
import { quickActionMatches } from './helpers/fake-gitlab.js';

/** The neutraliser's line-ending normalisation: CRLF → LF, then lone CR → LF. */
const lf = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const UNICODE_LEAD = '  -​  　﻿';
/** A line whose first non-blank character is an UNESCAPED `/`. */
const SLASH_LEAD = new RegExp(`^ {0,3}(?:[${UNICODE_LEAD}][ ${UNICODE_LEAD}]*)?/`);

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

/** Lines BOTH parsers place inside a code block — the only ones left unescaped. */
function agreedCode(text: string): Set<number> {
  const fenced = heuristicFenced(text);
  return new Set([...commonmarkCode(text)].filter((i) => fenced[i]));
}

/** Removes exactly the backslashes the neutraliser inserted (before a line-leading `/`). */
function unescape(text: string): string {
  return text.replace(
    /^( {0,3}(?:[  -​  　﻿][   -​  　﻿]*)?)\\\//gm,
    '$1/',
  );
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
};

/**
 * Inputs that bypassed the previous line-only neutraliser (its output still
 * executed a command) and close variants: a `\r` GitLab deletes, a fence-looking
 * line inside an HTML block / quote / list, a `\r` splitting a closing fence.
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
};

const ALL = { ...FIXTURES, ...BYPASSES };

describe('neutraliseQuickActions (AC-13)', () => {
  it('turns the spec example into escaped slashes', () => {
    expect(neutraliseQuickActions('/merge\n/close\nLGTM')).toBe('\\/merge\n\\/close\nLGTM');
  });

  it('the oracle sees commands in raw input (sanity) but none after neutralising', () => {
    expect(quickActionMatches(FIXTURES.spec!)).toEqual(['merge', 'close']);
    expect(quickActionMatches(FIXTURES.crlf!)).toEqual(['merge', 'close']);
    expect(quickActionMatches(FIXTURES.uppercase!)).toEqual(['MERGE', 'Close']);
    for (const [name, input] of Object.entries(ALL)) {
      const out = neutraliseQuickActions(input);
      expect(quickActionMatches(out), name).toEqual([]);
      expect(out, name).not.toContain('\r');
    }
  });

  it('blocks every known bypass of the line-only neutraliser', () => {
    for (const [name, input] of Object.entries(BYPASSES)) {
      expect(quickActionMatches(input).length, `${name}: raw input runs a command`).toBeGreaterThan(0);
      expect(quickActionMatches(neutraliseQuickActions(input)), name).toEqual([]);
    }
    const n = neutraliseQuickActions;
    expect(n(BYPASSES.crBeforeSlash!)).toBe('x\n\n\\/merge');
    expect(n(BYPASSES.crCrBeforeSlash!)).toBe('x\n\n\n\\/merge');
    expect(n(FIXTURES.crOnlyEndings!)).toBe('LGTM\n\n\\/merge\n\\/close');
    expect(n(BYPASSES.htmlBacktickFence!)).toBe('<div>\n```\n\n\\/merge\n');
    expect(n(BYPASSES.htmlTildeFence!)).toBe('<div>\n~~~\n\n\\/merge\n');
    // The CR becomes a line break, so GitLab sees the same unclosed fence we do:
    // `/merge` stays fenced code on both sides.
    expect(n(BYPASSES.crInClosingFence!)).toBe('```\nfoo\n`\n``\n/merge');
    expect(n(BYPASSES.details!)).toBe('<details>\n```\n\n\\/merge\n</details>');
    expect(n(BYPASSES.pre!)).toBe('<pre>\n```\n</pre>\n\n\\/merge');
  });

  it('leaves a `/` line unescaped only where both parsers agree it is code', () => {
    for (const [name, input] of Object.entries(ALL)) {
      const out = neutraliseQuickActions(input);
      const agreed = agreedCode(out);
      out.split('\n').forEach((line, i) => {
        if (SLASH_LEAD.test(line)) expect(agreed.has(i), `${name} line ${i}: ${line}`).toBe(true);
      });
    }
  });

  it('keeps genuine fenced blocks byte-identical (after LF normalisation) and is reversible', () => {
    for (const [name, input] of Object.entries(ALL)) {
      const normalised = lf(input);
      const out = neutraliseQuickActions(input);
      const inLines = normalised.split('\n');
      const outLines = out.split('\n');
      expect(outLines.length, name).toBe(inLines.length);
      for (const i of agreedCode(normalised)) expect(outLines[i], `${name} line ${i}`).toBe(inLines[i]);
      // `alreadyEscaped` is returned unchanged (asserted below); the naive unescape
      // helper would also strip the user's own backslash, so it is skipped here.
      if (name !== 'alreadyEscaped') expect(unescape(out), name).toBe(normalised);
    }
  });

  it('escapes only line-leading slashes outside agreed code blocks', () => {
    const n = neutraliseQuickActions;
    expect(n(FIXTURES.backtickFence!)).toBe('before\n```\n/merge\n```\n\\/close');
    expect(n(FIXTURES.unclosedFence!)).toBe(FIXTURES.unclosedFence);
    expect(n(FIXTURES.longFence!)).toBe('````\n/merge\n```\n/still inside\n````\n\\/label x');
    expect(n(FIXTURES.fenceInListItem!)).toBe('- item\n\n  ```\n  /merge\n  ```\n\n\\/close');
    expect(n(FIXTURES.leadingSpaces!)).toBe(' \\/merge\n  \\/approve\n   \\/label ~bug');
    // CRLF is not preserved: line endings are normalised to LF before escaping, so
    // the text sent is exactly the text analysed (GitLab deletes `\r` itself).
    expect(n(FIXTURES.crlf!)).toBe('\\/merge\n\\/close\nLGTM\n');
    expect(n(FIXTURES.crlfFence!)).toBe('```\n/merge\n```\n\\/close\n');
    expect(n(' /merge')).toBe(' \\/merge');
    // A fence-looking line inside a quote/list is not a top-level fence: over-escape.
    expect(n(BYPASSES.blockquoteFence!)).toBe('> ```\n\\/merge');
    expect(n(BYPASSES.listFence!)).toBe('- ```\n\\/merge');
    // Untouched: tab / 4-space indent (code), list, quote, mid-line, already escaped.
    for (const key of ['tab', 'fourSpaces', 'listItem', 'blockquote', 'midLine', 'alreadyEscaped']) {
      expect(n(FIXTURES[key]!), key).toBe(FIXTURES[key]);
    }
  });

  it('falls back to escaping every `/` line when the CommonMark parse is skipped', () => {
    // A > 64-char container prefix trips the parse guard: fenced `/` lines are
    // then escaped too (safe direction; no command can survive).
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
