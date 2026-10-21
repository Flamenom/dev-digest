/**
 * Finding note composer (spec `specs/2026-10-21-gitlab-publish-findings.md`,
 * AC-14 – AC-19, AC-42).
 */
import { describe, it, expect } from 'vitest';
import {
  composeFindingNote,
  composeSummary,
  downgradeForSingleLine,
  isBodyTooLong,
  noteLengthUpperBound,
  suggestionEligibility,
  type NoteAnchor,
  type NoteFinding,
} from '../src/modules/publish/note-body.js';
import { buildMarker } from '../src/modules/_shared/publish-marker.js';
import { stripAttribution } from '../src/modules/_shared/gitlab-note-text.js';
import { rawCommandLines } from './helpers/fake-gitlab.js';

const MARKER = buildMarker({
  workspaceId: '11111111-1111-4111-8111-111111111111',
  publicationId: '22222222-2222-4222-8222-222222222222',
  findingId: '33333333-3333-4333-8333-333333333333',
});
const FOOTER = '\n\n— posted by `Jane Doe` via DevDigest';
const ZWSP = '\u200B';

function finding(over: Partial<NoteFinding> = {}): NoteFinding {
  return {
    severity: 'WARNING',
    category: 'bug',
    title: 'Off-by-one in loop',
    rationale: 'The loop skips the last element.',
    suggestion: null,
    kind: 'finding',
    evidence: null,
    ...over,
  };
}

const multi: NoteAnchor = {
  kind: 'multi_line',
  path: 'src/a.ts',
  startLine: 10,
  endLine: 12,
  allAdded: true,
  anchorIsAdded: true,
};
const single: NoteAnchor = { kind: 'single_line', path: 'src/a.ts', startLine: 7, endLine: 7, allAdded: true, anchorIsAdded: true };
const general: NoteAnchor = { kind: 'general', path: 'src/`odd`\npath.ts', startLine: 40, endLine: 44 };

function compose(f: NoteFinding, anchor: NoteAnchor, opts: { apply?: boolean; footer?: string | null } = {}) {
  return composeFindingNote({
    finding: f,
    anchor,
    applySuggestion: opts.apply ?? false,
    marker: MARKER,
    footerName: opts.footer === undefined ? 'Jane Doe' : opts.footer,
  });
}

const SUGGESTION = '```ts\nfor (let i = 0; i <= n; i++) {\n  use(i);\n}\n```';

describe('composeFindingNote — AC-14 order (google vs local)', () => {
  it('plain finding', () => {
    expect(compose(finding(), multi).body).toBe(
      `**WARNING** · bug · Off-by-one in loop\n\nThe loop skips the last element.\n\n${MARKER}${FOOTER}`,
    );
    expect(compose(finding(), multi, { footer: null }).body).toBe(
      `**WARNING** · bug · Off-by-one in loop\n\nThe loop skips the last element.\n\n${MARKER}`,
    );
  });

  it('general (off-diff) finding carries the location line', () => {
    const f = finding({ severity: 'CRITICAL', category: 'security', title: 'Line\nbreak\ttitle\u2028x' });
    expect(compose(f, general).body).toBe(
      '**CRITICAL** · security · Line break title x\n' +
        '📍 `src/odd path.ts:40–44` (not on a changed line of this MR)\n\n' +
        `The loop skips the last element.\n\n${MARKER}${FOOTER}`,
    );
    const one = compose(finding(), { ...general, path: 'a.ts', startLine: 5, endLine: 5 }, { footer: null }).body;
    expect(one).toBe(
      '**WARNING** · bug · Off-by-one in loop\n📍 `a.ts:5` (not on a changed line of this MR)\n\n' +
        `The loop skips the last element.\n\n${MARKER}`,
    );
  });

  it('applicable suggestion', () => {
    const note = compose(finding({ suggestion: SUGGESTION }), multi, { apply: true });
    expect(note.suggestionApplicable).toBe(true);
    expect(note.body).toBe(
      '**WARNING** · bug · Off-by-one in loop\n\nThe loop skips the last element.\n\n' +
        '**Suggestion**\n\n```suggestion:-2+0\nfor (let i = 0; i <= n; i++) {\n  use(i);\n}\n```\n\n' +
        `${MARKER}${FOOTER}`,
    );
  });

  it('plain suggestion (toggle off) keeps the info string and prose', () => {
    const note = compose(finding({ suggestion: `Try this, @dev:\n\n${SUGGESTION}` }), multi, { footer: null });
    expect(note.suggestionApplicable).toBe(false);
    expect(note.body).toBe(
      '**WARNING** · bug · Off-by-one in loop\n\nThe loop skips the last element.\n\n' +
        `**Suggestion**\n\nTry this, @${ZWSP}dev:\n\n` +
        '```ts\nfor (let i = 0; i <= n; i++) {\n  use(i);\n}\n```\n\n' +
        MARKER,
    );
  });

  it('trifecta with evidence', () => {
    const f = finding({
      kind: 'lethal_trifecta',
      severity: 'CRITICAL',
      category: 'security',
      title: 'Lethal trifecta',
      rationale: 'Agent reads secrets, takes web input and can post.',
      evidence: [
        { component: 'private_data_access', file: 'src/db.ts', line: 3 },
        { component: 'exfil_path', file: 'lib/`http`.ts', line: 9 },
      ],
    });
    expect(compose(f, general).body).toBe(
      '**CRITICAL** · security · Lethal trifecta\n' +
        '📍 `src/odd path.ts:40–44` (not on a changed line of this MR)\n\n' +
        'Agent reads secrets, takes web input and can post.\n\n' +
        '**Evidence**\n\n- private_data_access `src/db.ts:3`\n- exfil_path `lib/http.ts:9`\n\n' +
        `${MARKER}${FOOTER}`,
    );
  });

  it('secret_leak → redacted body + fixed title, never the title/rationale/suggestion (AC-19)', () => {
    const f = finding({
      kind: 'secret_leak',
      severity: 'CRITICAL',
      category: 'security',
      title: 'Hardcoded AWS key AKIAIOSFODNN7EXAMPLE',
      rationale: 'Found AKIAIOSFODNN7EXAMPLE on line 3.',
      suggestion: '```\nconst key = "AKIAIOSFODNN7EXAMPLE";\n```',
    });
    for (const footer of ['Jane Doe', null]) {
      const { body, suggestionApplicable } = compose(f, single, { apply: true, footer });
      expect(suggestionApplicable).toBe(false);
      expect(body).not.toContain('AKIA');
      expect(body).not.toContain('Found');
      expect(body).not.toContain('Hardcoded');
      expect(body).toBe(
        '**CRITICAL** · security · Possible secret detected\n\n' +
          'A possible secret was detected on this line. Rotate it and remove it from history.\n\n' +
          MARKER +
          (footer ? FOOTER : ''),
      );
    }
  });

  it('the footer is the final line and still strips on read-back', () => {
    const body = compose(finding(), multi).body;
    expect(stripAttribution(body, true)).toEqual({
      body: `**WARNING** · bug · Off-by-one in loop\n\nThe loop skips the last element.\n\n${MARKER}`,
      attribution: { name: 'Jane Doe' },
    });
  });

  it('an unclosed fence in the rationale cannot swallow the marker', () => {
    const body = compose(finding({ rationale: 'See:\n```\ncode' }), multi, { footer: null }).body;
    expect(body).toBe(`**WARNING** · bug · Off-by-one in loop\n\nSee:\n\`\`\`\ncode\n\`\`\`\n\n${MARKER}`);
  });
});

describe('quick actions (AC-15)', () => {
  it('no command-shaped line in body or summary', () => {
    const f = finding({ title: '/merge', rationale: '/close\nreal text\n/approve', suggestion: 'do it\n/unassign @me' });
    for (const anchor of [multi, general]) {
      const { body } = compose(f, anchor);
      expect(rawCommandLines(body)).toEqual([]);
      expect(body).toContain('· /merge');
    }
    const summary = composeSummary('/label ~x\nOverall fine @team', 'Jane Doe');
    expect(rawCommandLines(summary)).toEqual([]);
    // The summary keeps mentions (no guard), the footer is last.
    expect(summary).toBe('\\/label ~x\nOverall fine @team' + FOOTER);
    expect(composeSummary('ok', null)).toBe('ok');
  });
});

describe('AC-17 suggestion eligibility', () => {
  const ok = finding({ suggestion: SUGGESTION });
  const cases: [string, NoteFinding, NoteAnchor, boolean][] = [
    ['toggle off', ok, multi, false],
    ['general anchor', ok, general, true],
    ['phantom kind', finding({ suggestion: SUGGESTION, kind: 'phantom' }), multi, true],
    ['a context line inside', ok, { ...multi, allAdded: false }, true],
    ['N = 101', ok, { ...multi, startLine: 1, endLine: 102 }, true],
    ['single context line', ok, { ...single, anchorIsAdded: false, allAdded: false }, true],
    ['single line not start==end', ok, { ...single, startLine: 6, endLine: 7 }, true],
    ['prose outside the fence', finding({ suggestion: `Use:\n${SUGGESTION}` }), multi, true],
    ['two fences', finding({ suggestion: `${SUGGESTION}\n${SUGGESTION}` }), multi, true],
    ['unclosed fence', finding({ suggestion: '```ts\nx()' }), multi, true],
    ['a /merge line in the code', finding({ suggestion: '```\nok()\n/merge\n```' }), multi, true],
  ];

  it.each(cases)('%s → plain block', (_name, f, anchor, toggle) => {
    const note = compose(f, anchor, { apply: toggle });
    expect(note.suggestionApplicable).toBe(false);
    expect(note.body).not.toMatch(/suggestion:-/);
    if (_name !== 'toggle off') expect(suggestionEligibility(f, anchor)).toBe(false);
  });

  it('all hold → suggestion:-N+0 (multi-line and single added line, kind absent, ~~~ fence)', () => {
    expect(suggestionEligibility(ok, multi)).toBe(true);
    expect(compose(ok, { ...multi, startLine: 1, endLine: 101 }, { apply: true }).body).toContain('```suggestion:-100+0\n');
    const tilde = finding({ kind: null, suggestion: '  ~~~python\nprint(1)\n~~~  ' });
    const note = compose(tilde, single, { apply: true });
    expect(note.suggestionApplicable).toBe(true);
    expect(note.body).toContain('**Suggestion**\n\n```suggestion:-0+0\nprint(1)\n```\n\n');
    expect(suggestionEligibility(finding({ suggestion: null }), multi)).toBe(false);
  });

  it('a fence longer than any backtick run inside', () => {
    const inner = '````md\nExample:\n```js\nx()\n```\n````';
    const applicable = compose(finding({ suggestion: inner }), multi, { apply: true }).body;
    expect(applicable).toContain('````suggestion:-2+0\nExample:\n```js\nx()\n```\n````');
    const plain = compose(finding({ suggestion: inner }), multi).body;
    expect(plain).toContain('````md\nExample:\n```js\nx()\n```\n````');
    const run = compose(finding({ suggestion: '```\nconst s = `````;\n```' }), multi).body;
    expect(run).toContain('``````\nconst s = `````;\n``````');
  });

  it('downgradeForSingleLine drops a range-dependent suggestion (AC-13)', () => {
    const input = { finding: ok, anchor: multi, applySuggestion: true, marker: MARKER, footerName: null };
    expect(composeFindingNote(input).suggestionApplicable).toBe(true);
    const down = downgradeForSingleLine(input);
    expect(down.suggestionApplicable).toBe(false);
    expect(down.body).toContain('```ts\nfor');
    const one = downgradeForSingleLine({ ...input, anchor: single });
    expect(one.suggestionApplicable).toBe(true);
  });
});

describe('AC-18 length bound', () => {
  it('is ≥ the composed length for 20 deterministic random fixtures', () => {
    let seed = 42;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const atoms = ['@all ', '#12 ', '/merge\n', '`code` ', '```\n', '![x](y) ', 'text ', '\n\n', '~l ', '<img ', '😀 '];
    const text = (k: number): string => Array.from({ length: k }, () => atoms[rnd(atoms.length)]).join('');
    const anchors = [multi, single, general];
    for (let i = 0; i < 20; i++) {
      const f = finding({
        title: text(5),
        rationale: text(40),
        suggestion: i % 2 ? `\`\`\`\n${text(10).replace(/`/g, '')}\n\`\`\`` : text(10),
      });
      const anchor = anchors[i % 3]!;
      const bound = noteLengthUpperBound(f, anchor);
      for (const apply of [true, false]) {
        const body = composeFindingNote({
          finding: f,
          anchor,
          applySuggestion: apply,
          marker: MARKER,
          footerName: 'x'.repeat(100),
        }).body;
        expect(bound).toBeGreaterThanOrEqual(body.length);
      }
    }
  });

  it('a 1,000,000-char rationale is over the limit; a normal one is not', () => {
    expect(isBodyTooLong(finding({ rationale: 'a'.repeat(1_000_000) }), multi)).toBe(true);
    expect(isBodyTooLong(finding(), multi)).toBe(false);
  });
});
