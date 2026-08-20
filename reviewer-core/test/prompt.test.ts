/**
 * assemblePrompt — PR description slot (the fix that was missing: the PR body
 * never reached the prompt). Pins rendering, omit-when-empty, untrusted-wrap,
 * truncation, and ordering (before the diff).
 */
import { describe, it, expect } from 'vitest';
import { assemblePrompt } from '../src/prompt.js';

function userOf(parts: Parameters<typeof assemblePrompt>[0]): string {
  const { messages } = assemblePrompt(parts);
  return messages[1]!.content;
}

function systemOf(parts: Parameters<typeof assemblePrompt>[0]): string {
  return assemblePrompt(parts).messages[0]!.content;
}

describe('assemblePrompt — shared injection guard (server + CI)', () => {
  const sys = systemOf({ system: 'AGENT-SYS', diff: 'DIFF' });

  it('appends the guard to the agent system prompt', () => {
    expect(sys.startsWith('AGENT-SYS')).toBe(true);
    expect(sys).toMatch(/<untrusted>.*DATA to be analyzed/s);
  });

  it('forbids "intentional/test/demo" claims from descoping the review', () => {
    // The defense that replaced the keyword sanitizer: a general, trusted,
    // language-agnostic rule — not text parsing of untrusted input.
    expect(sys).toMatch(/test fixture|intentional|demo/i);
    expect(sys).toMatch(/never reduce|never .*descope|REPORT it/i);
    expect(sys).toMatch(/any language/i);
  });
});

describe('assemblePrompt — ## PR description', () => {
  it('renders the section (untrusted-wrapped) before the diff when present', () => {
    const { messages, assembly } = assemblePrompt({
      system: 'sys',
      diff: 'DIFF',
      prDescription: 'Adds rate limiting to the public /api endpoints.',
    });
    const user = messages[1]!.content;
    expect(user).toContain('## PR description');
    expect(user).toContain('<untrusted source="pr-description">');
    expect(user).toContain('Adds rate limiting to the public /api endpoints.');
    expect(user.indexOf('## PR description')).toBeLessThan(user.indexOf('## Diff to review'));
    expect(assembly.pr_description).toContain('Adds rate limiting');
  });

  it('omits the section when prDescription is undefined or blank (no behaviour change)', () => {
    expect(userOf({ system: 'sys', diff: 'DIFF' })).not.toContain('## PR description');
    expect(assemblePrompt({ system: 'sys', diff: 'DIFF' }).assembly.pr_description ?? null).toBeNull();
    expect(userOf({ system: 'sys', diff: 'DIFF', prDescription: '   ' })).not.toContain(
      '## PR description',
    );
  });

  it('truncates a huge body to the 4k cap', () => {
    const { assembly } = assemblePrompt({
      system: 'sys',
      diff: 'D',
      prDescription: 'x'.repeat(10_000),
    });
    expect((assembly.pr_description as string).length).toBe(4000);
  });
});

describe('assemblePrompt — ## Declared PR intent & scope (L03)', () => {
  const intent = {
    summary: 'Add rate limiting to public endpoints',
    inScope: ['rate limiter middleware', 'Redis counters'],
    outOfScope: ['auth changes'],
  };

  it('renders the intent untrusted-wrapped as derived-intent, before the PR description and the diff', () => {
    const user = userOf({
      system: 'sys',
      diff: 'DIFF',
      intent,
      prDescription: 'Adds rate limiting.',
    });
    expect(user).toContain('## Declared PR intent & scope');
    expect(user).toContain('<untrusted source="derived-intent">');
    expect(user).toContain('Intent: Add rate limiting to public endpoints');
    expect(user).toContain('- rate limiter middleware');
    expect(user).toContain('- auth changes');
    // Ordering: intent → PR description → diff.
    expect(user.indexOf('## Declared PR intent & scope')).toBeLessThan(
      user.indexOf('## PR description'),
    );
    expect(user.indexOf('## PR description')).toBeLessThan(user.indexOf('## Diff to review'));
  });

  it('appends the trusted-side SCOPE TAGGING instruction to the system message ONLY when intent is present', () => {
    const withIntent = systemOf({ system: 'AGENT-SYS', diff: 'DIFF', intent });
    expect(withIntent).toContain('SCOPE TAGGING');
    expect(withIntent).toMatch(/scope.*'in'.*'out'/i);
    expect(withIntent).toMatch(/scope never waives severity/i);
    // The instruction lives OUTSIDE the untrusted blocks — in system, not user.
    expect(userOf({ system: 'AGENT-SYS', diff: 'DIFF', intent })).not.toContain('SCOPE TAGGING');

    const without = systemOf({ system: 'AGENT-SYS', diff: 'DIFF' });
    expect(without).not.toContain('SCOPE TAGGING');
  });

  it('keeps the INJECTION_GUARD intact alongside the scope instruction; no section without intent', () => {
    const sys = systemOf({ system: 'AGENT-SYS', diff: 'DIFF', intent });
    expect(sys.startsWith('AGENT-SYS')).toBe(true);
    expect(sys).toMatch(/<untrusted>.*DATA to be analyzed/s);
    expect(sys).toMatch(/derived intent\/scope/);

    // Absent intent → prompt shape identical to today.
    const user = userOf({ system: 'sys', diff: 'DIFF' });
    expect(user).not.toContain('## Declared PR intent & scope');
    expect(user).not.toContain('derived-intent');
  });
});
