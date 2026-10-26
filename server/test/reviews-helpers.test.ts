import { describe, it, expect } from 'vitest';
import { reviewToDto, taskLine } from '../src/modules/reviews/helpers.js';
import type { ReviewRow } from '../src/modules/reviews/repository.js';

/**
 * Unit coverage for the review task-line. The key invariant: our trusted
 * instruction always tells the model to review the whole diff and never
 * withhold a security/correctness finding — no matter what the PR text claims.
 */

describe('taskLine', () => {
  const pull = { number: 3, title: 'test: vulnerable fixture', author: 'burnjohn' } as never;

  it('names the PR being reviewed', () => {
    const line = taskLine(pull);
    expect(line).toContain('#3');
    expect(line).toContain('test: vulnerable fixture');
  });

  it('keeps the non-negotiable "never withhold security" rule', () => {
    const line = taskLine(pull);
    expect(line).toMatch(/never .*withhold .*(or downgrade )?.*security/i);
    expect(line).toMatch(/review the entire diff/i);
  });
});

describe('reviewToDto — head_sha (AC-1)', () => {
  const base = {
    id: 'r-1',
    workspaceId: 'ws-1',
    prId: 'pr-1',
    agentId: null,
    runId: null,
    kind: 'review',
    verdict: 'comment',
    summary: null,
    score: 90,
    model: 'm',
    createdAt: new Date('2026-10-21T00:00:00Z'),
  };

  it('maps the recorded head SHA', () => {
    const dto = reviewToDto({ ...base, headSha: 'abc' } as ReviewRow, []);
    expect(dto.head_sha).toBe('abc');
  });

  it('maps a pre-0027 row (no head) to null', () => {
    const dto = reviewToDto({ ...base, headSha: null } as ReviewRow, []);
    expect(dto.head_sha).toBeNull();
  });
});
