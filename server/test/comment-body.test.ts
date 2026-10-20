/**
 * Pure comment-body transforms (spec `specs/2026-10-20-gitlab-comments.md`):
 * quick-action neutralisation (AC-13), attribution footer (AC-16 – AC-18) and
 * footer stripping on read (AC-7).
 *
 * The AC-13 oracle ports GitLab's quick-action extractor regex verbatim
 * (`lib/gitlab/quick_actions/extractor.rb`, flags m + i, `\r` stripped first)
 * and runs it over every line OUTSIDE fenced code. Banzai's top-level-paragraph
 * filter and GitLab's render of `\/` are NOT reproducible offline — those are
 * covered by the manual sandbox smoke recorded in the PR description.
 */
import { describe, it, expect } from 'vitest';
import {
  composeGitLabText,
  footerFor,
  neutraliseQuickActions,
  sanitiseFooterName,
  stripAttribution,
} from '../src/modules/pulls/comment-body.js';

const COMMANDS = [
  'merge', 'close', 'reopen', 'approve', 'unapprove', 'assign', 'unassign', 'label',
  'unlabel', 'relabel', 'milestone', 'draft', 'ready', 'rebase', 'submit_review',
  'shrug', 'tableflip', 'spend', 'estimate',
];
/** GitLab's extractor regex: ^\/(?<cmd>NAMES)(?:[ ](?<arg>[^\n]*))?(?:\s*\n|$) (m, i). */
const EXTRACTOR = new RegExp(
  `^\\/(?<cmd>${COMMANDS.join('|')})(?:[ ](?<arg>[^\\n]*))?(?:\\s*\\n|$)`,
  'gmi',
);

/** Splits text into [outsideFenceText, fencedLines] using the same CommonMark fence rules. */
function splitFences(text: string): { outside: string; fenced: string[] } {
  const outside: string[] = [];
  const fenced: string[] = [];
  let open: { char: string; len: number } | null = null;
  for (const line of text.split('\n')) {
    const l = line.replace(/\r$/, '');
    if (open) {
      fenced.push(line);
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
      if (m && m[1]![0] === open.char && m[1]!.length >= open.len) open = null;
      continue;
    }
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l);
    if (m && !(m[1]![0] === '`' && m[2]!.includes('`'))) {
      open = { char: m[1]![0]!, len: m[1]!.length };
      fenced.push(line);
      continue;
    }
    outside.push(line);
  }
  return { outside: outside.join('\n'), fenced };
}

function quickActions(text: string): string[] {
  const { outside } = splitFences(text.replace(/\r/g, ''));
  return [...outside.matchAll(EXTRACTOR)].map((m) => m.groups!.cmd!);
}

/** Removes exactly the backslashes the neutraliser inserted (before a line-leading `/`). */
function unescape(text: string): string {
  return text.replace(
    /^( {0,3}(?:[\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF][ \u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]*)?)\\\//gm,
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
  unicodeLead: '\u00A0/merge\n\u200B/close\n\u3000 /approve\n\uFEFF/shrug',
  backtickFence: 'before\n```\n/merge\n```\n/close',
  tildeFence: '~~~sh\n/merge\n~~~\n/close after',
  longFence: '````\n/merge\n```\n/still inside\n````\n/label x',
  mixedFenceChars: '```\n/merge\n~~~\n/inside\n```\n/outside',
  unclosedFence: 'text\n```\n/merge\n/close',
  indentedFence: '   ```\n/merge\n   ```\n/close',
  withArgs: '/assign @alice\n/label ~bug ~p1\n/spend 1h',
  blankLines: '\n\n/merge\n\n',
  alreadyEscaped: '\\/merge',
};

describe('neutraliseQuickActions (AC-13)', () => {
  it('turns the spec example into escaped slashes', () => {
    expect(neutraliseQuickActions('/merge\n/close\nLGTM')).toBe('\\/merge\n\\/close\nLGTM');
  });

  it('the oracle sees commands in raw input (sanity) but none after neutralising', () => {
    expect(quickActions(FIXTURES.spec!)).toEqual(['merge', 'close']);
    expect(quickActions(FIXTURES.crlf!)).toEqual(['merge', 'close']);
    expect(quickActions(FIXTURES.uppercase!)).toEqual(['MERGE', 'Close']);
    for (const [name, input] of Object.entries(FIXTURES)) {
      const out = neutraliseQuickActions(input);
      expect(quickActions(out), name).toEqual([]);
    }
  });

  it('keeps fenced content byte-identical and is reversible', () => {
    for (const [name, input] of Object.entries(FIXTURES)) {
      const out = neutraliseQuickActions(input);
      expect(splitFences(out).fenced, name).toEqual(splitFences(input).fenced);
      // `alreadyEscaped` is returned unchanged (asserted below); the naive unescape
      // helper would also strip the user's own backslash, so it is skipped here.
      if (name !== 'alreadyEscaped') expect(unescape(out), name).toBe(input);
    }
  });

  it('escapes only line-leading slashes outside fences', () => {
    expect(neutraliseQuickActions(FIXTURES.backtickFence!)).toBe('before\n```\n/merge\n```\n\\/close');
    expect(neutraliseQuickActions(FIXTURES.unclosedFence!)).toBe(FIXTURES.unclosedFence);
    expect(neutraliseQuickActions(FIXTURES.longFence!)).toBe('````\n/merge\n```\n/still inside\n````\n\\/label x');
    expect(neutraliseQuickActions(FIXTURES.leadingSpaces!)).toBe(' \\/merge\n  \\/approve\n   \\/label ~bug');
    expect(neutraliseQuickActions(FIXTURES.crlf!)).toBe('\\/merge\r\n\\/close\r\nLGTM\r\n');
    expect(neutraliseQuickActions('\u00A0/merge')).toBe('\u00A0\\/merge');
    // Untouched: tab / 4-space indent (code), list, quote, mid-line, already escaped.
    for (const key of ['tab', 'fourSpaces', 'listItem', 'blockquote', 'midLine', 'alreadyEscaped']) {
      expect(neutraliseQuickActions(FIXTURES[key]!), key).toBe(FIXTURES[key]);
    }
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
