/**
 * AC-16 mention / reference / image guard (spec
 * `specs/2026-10-21-gitlab-publish-findings.md`; plan "Mention / reference /
 * image guard — decision").
 *
 * Invariant checked on the output OUTSIDE code: none of the ported GitLab
 * reference patterns matches. Code regions are byte-identical, and removing
 * every inserted U+200B / `\` gives the input back. The rendered result on a
 * real MR is manual verification #12.
 */
import { describe, it, expect } from 'vitest';
import { guardFindingText } from '../src/modules/publish/mention-guard.js';

const ZWSP = '\u200B';

/** Ported GitLab reference patterns (+ unescaped image / media tag syntax). */
const PATTERNS: Record<string, RegExp> = {
  user: /(?<![\w`])@[\w.\-]+/g,
  issue: /#\d+/g,
  mr: /!\d+/g,
  label: /~[\w"]/g,
  milestone: /%[\w"]/g,
  epic: /&\d+/g,
  crossProject: /[\w.\-]+\/[\w.\-]+[#!]\d+/g,
  image: /(?<!\\)!\[/g,
  htmlMedia: /(?<!\\)<(?:img|video|audio|iframe|picture|object|embed)\b/gi,
};

/** Removes inline code spans and fenced blocks, so only text GitLab would scan remains. */
function outsideCode(text: string): string {
  return text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '').replace(/(`+)[^`]*?\1/g, '');
}

function refMatches(text: string): string[] {
  const t = outsideCode(text);
  return Object.entries(PATTERNS).flatMap(([name, re]) => [...t.matchAll(re)].map((m) => `${name}:${m[0]}`));
}

function unguard(text: string): string {
  return text.replaceAll(ZWSP, '').replace(/\\([!<])/g, '$1');
}

describe('guardFindingText', () => {
  it('neutralises the spec fixture: mention, issue ref, image (AC-16)', () => {
    const input = 'ping @all, see #12 ![x](https://evil.example/p.png)';
    const out = guardFindingText(input);
    expect(refMatches(input).length).toBeGreaterThan(0);
    expect(refMatches(out)).toEqual([]);
    expect(unguard(out)).toBe(input);
    // The image URL text stays (now a plain link).
    expect(out).toContain('(https://evil.example/p.png)');
  });

  it.each([
    ['@Override and @group/sub', 'user'],
    ['fixes !45 and #7', 'mr+issue'],
    ['labels ~bug ~"needs review" and %v1.0 %"Sprint 3"', 'label+milestone'],
    ['see group/project#1 and other/proj!2', 'cross'],
    ['epic &12 and snippet $3', 'epic+snippet'],
    ['<img src=x onerror=alert(1)> <IFRAME src="https://e"> <video src=a>', 'html'],
    ['![alt][ref] and ![a](b)', 'images'],
    ['escaped \\@all and \\#12 still decode to refs', 'escaped'],
    ['entity &#64;all &#x23;12 &commat;dev &amp;5', 'entities'],
  ])('%s → no reference outside code (%s)', (input) => {
    const out = guardFindingText(input);
    expect(refMatches(out.replace(/&#64;|&commat;/g, '@').replace(/&#x23;/g, '#').replace(/&amp;/g, '&'))).toEqual([]);
    expect(unguard(out)).toBe(input);
  });

  it('leaves code spans and fenced blocks byte-identical', () => {
    expect(guardFindingText('use `@all` here')).toBe('use `@all` here');
    expect(guardFindingText('a ``x ` @y`` b @z')).toBe(`a \`\`x \` @y\`\` b @${ZWSP}z`);
    const fenced = '```ts\nconst a = "#12 @all ![x](y)";\n```';
    expect(guardFindingText(`Intro @bob\n\n${fenced}\n\nOutro #3`)).toBe(
      `Intro @${ZWSP}bob\n\n${fenced}\n\nOutro #${ZWSP}3`,
    );
    const tilde = '~~~\n#12\n~~~';
    expect(guardFindingText(tilde)).toBe(tilde);
  });

  it('does not touch link destinations or bare URLs', () => {
    const link = '[docs](https://a.example/b#12) and <https://x.example/#3>';
    expect(guardFindingText(link)).toBe(link);
    expect(guardFindingText('see https://gitlab.com/g/p/-/issues/1#note_9 now')).toBe(
      'see https://gitlab.com/g/p/-/issues/1#note_9 now',
    );
    // Link TEXT is still guarded.
    expect(guardFindingText('[ping @all](https://a.example)')).toBe(`[ping @${ZWSP}all](https://a.example)`);
  });

  it('leaves ordinary text alone and is idempotent', () => {
    const plain = '# Heading\n\n50% done, a ~ b, 3 ! 4, C# and F#, email-ish x @ y';
    expect(guardFindingText(plain)).toBe(plain);
    const input = 'ping @all #12 ![x](u) <img src=a> &#64;b';
    const once = guardFindingText(input);
    expect(guardFindingText(once)).toBe(once);
  });

  it('guards a backtick that never closes as plain text', () => {
    const out = guardFindingText('a ` @all');
    expect(out).toBe(`a \` @${ZWSP}all`);
  });

  it('a code span does not cross a blank line', () => {
    const out = guardFindingText('a `x\n\n@all` b');
    expect(refMatches(out.replace(/`/g, ''))).toEqual([]);
  });
});
