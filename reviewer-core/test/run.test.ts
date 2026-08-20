import { describe, it, expect } from 'vitest';
import type { LLMProvider, StructuredResult } from '@devdigest/shared';
import { Review as ReviewSchema, ScopedReview as ScopedReviewSchema } from '@devdigest/shared';
import { MockLLMProvider, MockGitClient } from '../../server/src/adapters/mocks.js';
import { reviewPullRequest, OUT_OF_SCOPE_KEPT_PREFIX } from '../src/index.js';

/**
 * Engine-level test for reviewPullRequest (the core lifted out of the server's
 * runOneAgent). Uses the server's mock LLM + git so we exercise the real
 * assemble → completeStructured → reduce → grounding pipeline with no DB/SSE.
 */
describe('reviewPullRequest (engine)', () => {
  // One grounded finding (line 11 is in the MockGitClient diff) + one
  // hallucinated finding (line 999) the grounding gate must drop.
  const fixture = {
    verdict: 'request_changes',
    summary: 'secret key committed',
    score: 38,
    findings: [
      {
        id: 'f1',
        severity: 'CRITICAL',
        category: 'security',
        title: 'Hardcoded Stripe secret key',
        file: 'src/config.ts',
        start_line: 11,
        end_line: 11,
        rationale: 'sk_live in diff',
        confidence: 0.98,
        kind: 'finding',
      },
      {
        id: 'f-hallucinated',
        severity: 'WARNING',
        category: 'bug',
        title: 'phantom finding on a line not in the diff',
        file: 'src/config.ts',
        start_line: 999,
        end_line: 999,
        rationale: 'not real',
        confidence: 0.3,
        kind: 'finding',
      },
    ],
  };

  it('single-pass: assembles, grounds, drops the hallucinated finding', async () => {
    const llm = new MockLLMProvider('openai', { structured: fixture });
    const diff = await new MockGitClient().diff();

    const events: string[] = [];
    const outcome = await reviewPullRequest({
      systemPrompt: 'security reviewer',
      model: 'gpt-4.1',
      diff,
      llm,
      task: 'Review PR #482',
      onEvent: (e) => events.push(e.msg),
    });

    expect(outcome.mode).toBe('single-pass');
    expect(outcome.grounding).toBe('1/2 passed');
    expect(outcome.review.findings).toHaveLength(1);
    expect(outcome.review.findings[0]!.start_line).toBe(11);
    expect(outcome.dropped).toHaveLength(1);
    // Score is derived from the SURVIVING findings, not the model's self-reported
    // 38: one CRITICAL remains after grounding ⇒ 100 − 35 = 65.
    expect(outcome.review.score).toBe(65);
    // progress is surfaced (server bridges this onto SSE; runner logs it)
    expect(events.some((m) => m.includes('Citation grounding'))).toBe(true);
  });

  it('score is deterministic from findings: a clean approve scores 100', async () => {
    // Model "approves" but reports a nonsense low score (the cheap-model bug).
    // The engine must ignore that and score the zero findings as a perfect 100.
    const clean = { verdict: 'approve', summary: 'looks good', score: 10, findings: [] };
    const llm = new MockLLMProvider('openai', { structured: clean });
    const diff = await new MockGitClient().diff();

    const outcome = await reviewPullRequest({
      systemPrompt: 'security reviewer',
      model: 'deepseek/deepseek-v4-flash',
      diff,
      llm,
      task: 'Review PR #5',
    });

    expect(outcome.review.findings).toHaveLength(0);
    expect(outcome.review.score).toBe(100);
  });

  it('checkCancelled throwing aborts before the LLM call', async () => {
    const llm = new MockLLMProvider('openai', { structured: fixture });
    const diff = await new MockGitClient().diff();
    await expect(
      reviewPullRequest({
        systemPrompt: 's',
        model: 'gpt-4.1',
        diff,
        llm,
        checkCancelled: () => {
          throw new Error('cancelled');
        },
      }),
    ).rejects.toThrow('cancelled');
  });

  // ---- L03 — intent & scope filter ---------------------------------------

  // All four findings cite line 11 (real in the MockGitClient diff), so ALL
  // pass grounding — what happens next is purely the scope filter's doing.
  const scopedFinding = (over: Record<string, unknown>) => ({
    id: 'f',
    severity: 'CRITICAL',
    category: 'security',
    title: 't',
    file: 'src/config.ts',
    start_line: 11,
    end_line: 11,
    rationale: 'grounded rationale',
    confidence: 0.9,
    kind: 'finding',
    ...over,
  });
  const scopedFixture = {
    verdict: 'request_changes',
    summary: 'scoped review',
    score: 7, // nonsense self-reported score — must be ignored
    findings: [
      scopedFinding({ id: 'f-in', scope: 'in', title: 'in-scope critical' }),
      scopedFinding({ id: 'f-out-high', scope: 'out', confidence: 0.9, title: 'out survivor' }),
      scopedFinding({ id: 'f-out-low', scope: 'out', confidence: 0.5, title: 'out critical dup' }),
      scopedFinding({ id: 'f-out-warn', scope: 'out', severity: 'WARNING', title: 'out warning' }),
    ],
  };
  const intent = {
    summary: 'Add rate limiting to public endpoints',
    inScope: ['rate limiter middleware'],
    outOfScope: ['auth changes'],
  };

  it('with intent: ScopedReview schema requested, scope filter runs after grounding, score recomputed from the kept set, drops emitted', async () => {
    const llm = new MockLLMProvider('openai', { structured: scopedFixture });
    const diff = await new MockGitClient().diff();

    const events: string[] = [];
    const outcome = await reviewPullRequest({
      systemPrompt: 'security reviewer',
      model: 'gpt-4.1',
      diff,
      llm,
      intent,
      onEvent: (e) => events.push(e.msg),
    });

    // Scope-tagged superset schema requested; schemaName stays 'Review' so
    // fixtures keyed on it keep working.
    const req = llm.calls[0]!.req as { schema: unknown; schemaName: string };
    expect(req.schema).toBe(ScopedReviewSchema);
    expect(req.schemaName).toBe('Review');

    // Kept: the in-scope finding + exactly ONE CRITICAL out-of-scope survivor.
    expect(outcome.review.findings.map((f) => f.id)).toEqual(['f-in', 'f-out-high']);
    const survivor = outcome.review.findings.find((f) => f.id === 'f-out-high')!;
    expect(survivor.rationale).toBe(`${OUT_OF_SCOPE_KEPT_PREFIX}grounded rationale`);
    // `scope` is stripped — the outcome carries frozen Findings only.
    for (const f of outcome.review.findings) expect('scope' in f).toBe(false);

    // Score recomputed from the POST-scope kept set (2 CRITICAL ⇒ 100 − 70),
    // not the model's 7 and not the pre-filter 4-finding set.
    expect(outcome.review.score).toBe(30);

    // Every drop is an event — never silent.
    expect(events.some((m) => m.includes('scope filter dropped "out critical dup"'))).toBe(true);
    expect(events.some((m) => m.includes('scope filter dropped "out warning"'))).toBe(true);
    expect(events.some((m) => m.includes('Scope filter: 2/4 kept'))).toBe(true);
  });

  it('without intent: plain Review schema, no scope filter — even model-emitted scope tags are inert', async () => {
    // Same scoped fixture: Review parsing strips the unknown `scope` keys, so
    // the no-intent path is byte-identical to pre-L03 behavior.
    const llm = new MockLLMProvider('openai', { structured: scopedFixture });
    const diff = await new MockGitClient().diff();

    const events: string[] = [];
    const outcome = await reviewPullRequest({
      systemPrompt: 'security reviewer',
      model: 'gpt-4.1',
      diff,
      llm,
      onEvent: (e) => events.push(e.msg),
    });

    const req = llm.calls[0]!.req as { schema: unknown };
    expect(req.schema).toBe(ReviewSchema);

    // All 4 grounded findings survive — nothing is scope-dropped.
    expect(outcome.review.findings).toHaveLength(4);
    expect(events.some((m) => m.toLowerCase().includes('scope filter'))).toBe(false);
    // Score still deterministic: 3×CRITICAL + 1×WARNING ⇒ max(0, 100 − 117) = 0.
    expect(outcome.review.score).toBe(0);
    // No rationale gained the out-of-scope prefix.
    for (const f of outcome.review.findings) {
      expect(f.rationale).toBe('grounded rationale');
    }
  });

  it('forwards sessionId to every LLM call (OpenRouter session grouping)', async () => {
    const seen: (string | undefined)[] = [];
    const recorder: LLMProvider = {
      id: 'openrouter',
      async completeStructured<T>(req): Promise<StructuredResult<T>> {
        seen.push(req.sessionId);
        return {
          data: fixture as unknown as T,
          model: req.model,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          raw: '',
          attempts: 1,
        };
      },
      async listModels() {
        return [];
      },
      async complete() {
        throw new Error('not used');
      },
      async embed() {
        return [];
      },
    };
    const diff = await new MockGitClient().diff();
    await reviewPullRequest({ systemPrompt: 's', model: 'm', diff, llm: recorder, sessionId: 'sess-abc' });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s === 'sess-abc')).toBe(true);
  });
});
