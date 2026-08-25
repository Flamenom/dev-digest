import { describe, expect, it } from 'vitest';
import {
  AgentsOutput,
  BlastRadiusOutput,
  ConventionsOutput,
  FindingsOutput,
  RunOutput,
  mapAgents,
  mapBlast,
  mapConventions,
  mapFindings,
  mapRunDone,
} from '../src/mappers.js';
import {
  AGENT,
  AGENT_2,
  BLAST_RESPONSE,
  CONVENTIONS_RESPONSE,
  makeConvention,
  makeFinding,
  makeReview,
  makeRun,
} from './fixtures.js';

describe('mapAgents', () => {
  it('projects only the listed fields and counts the total', () => {
    const out = mapAgents([AGENT, AGENT_2]);
    expect(AgentsOutput.parse(out)).toEqual(out);
    expect(out.total).toBe(2);
    expect(out.agents[0]).toEqual({
      id: AGENT.id,
      name: AGENT.name,
      description: AGENT.description,
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      enabled: true,
      skill_count: 2,
    });
    // No system_prompt / output_schema leakage.
    expect(Object.keys(out.agents[0]!)).not.toContain('system_prompt');
  });
});

describe('mapFindings', () => {
  const reviews = [
    makeReview({
      id: 'review-a',
      agent_name: 'Security Reviewer',
      findings: [
        makeFinding({ id: 'f1', severity: 'SUGGESTION', title: 's1' }),
        makeFinding({ id: 'f2', severity: 'CRITICAL', title: 'c1' }),
        makeFinding({ id: 'f3', severity: 'WARNING', title: 'w1' }),
      ],
    }),
    makeReview({
      id: 'review-b',
      run_id: 'run-2',
      agent_name: 'Perf Reviewer',
      findings: [makeFinding({ id: 'f4', severity: 'CRITICAL', title: 'c2' })],
    }),
  ];
  const runs = [makeRun({ status: 'done' }), makeRun({ run_id: 'run-3', status: 'running' })];
  const base = { repo: 'acme/payments-api', prNumber: 482 };

  it('sorts CRITICAL → WARNING → SUGGESTION and counts running runs', () => {
    const out = mapFindings(reviews, runs, base);
    expect(FindingsOutput.parse(out)).toEqual(out);
    expect(out.findings.map((f) => f.severity)).toEqual([
      'CRITICAL',
      'CRITICAL',
      'WARNING',
      'SUGGESTION',
    ]);
    expect(out.running_runs).toBe(1);
    expect(out.reviews).toHaveLength(2);
    expect(out.total_findings).toBe(4);
    expect(out.has_more).toBe(false);
  });

  it('is concise by default (no rationale) and detailed on request', () => {
    const concise = mapFindings(reviews, runs, base);
    expect(concise.findings[0]).toEqual({
      severity: 'CRITICAL',
      category: 'bug',
      title: 'c1',
      file: 'src/pay.ts',
      start_line: 10,
      agent_name: 'Security Reviewer',
    });

    const detailed = mapFindings(reviews, runs, { ...base, format: 'detailed' });
    expect(detailed.findings[0]).toMatchObject({
      title: 'c1',
      end_line: 12,
      rationale: 'Float math on money.',
      suggestion: 'Use integer cents.',
      confidence: 0.8,
      accepted: false,
      dismissed: false,
      review_id: 'review-uuid-1',
    });
  });

  it('filters by agent name (case-insensitive) and by severity', () => {
    const byAgent = mapFindings(reviews, runs, { ...base, agentName: 'perf reviewer' });
    expect(byAgent.findings.map((f) => f.title)).toEqual(['c2']);
    expect(byAgent.reviews.map((r) => r.review_id)).toEqual(['review-b']);

    const bySeverity = mapFindings(reviews, runs, { ...base, severity: 'WARNING' });
    expect(bySeverity.findings.map((f) => f.title)).toEqual(['w1']);
    expect(bySeverity.total_findings).toBe(1);
  });

  it('slices to limit and sets has_more', () => {
    const out = mapFindings(reviews, runs, { ...base, limit: 2 });
    expect(out.findings).toHaveLength(2);
    expect(out.total_findings).toBe(4);
    expect(out.has_more).toBe(true);
  });
});

describe('mapRunDone', () => {
  it('builds the done output from run + review, concise findings capped at 20', () => {
    const findings = Array.from({ length: 25 }, (_, i) =>
      makeFinding({ id: `f${i}`, severity: i === 24 ? 'CRITICAL' : 'SUGGESTION', title: `t${i}` }),
    );
    const review = makeReview({ findings });
    const run = makeRun({ status: 'done', score: 61, blockers: 1 });

    const out = mapRunDone(run, review);
    expect(RunOutput.parse(out)).toEqual(out);
    expect(out.status).toBe('done');
    expect(out.run_id).toBe('run-uuid-1');
    expect(out.verdict).toBe('comment');
    expect(out.score).toBe(61);
    expect(out.summary).toBe('Mostly fine.');
    expect(out.blockers).toBe(1);
    expect(out.findings_count).toBe(25);
    expect(out.findings).toHaveLength(20);
    expect(out.findings[0]!.severity).toBe('CRITICAL'); // sorted before slicing
    expect(out.findings[0]!.rationale).toBeUndefined(); // concise
    expect(out.truncated).toBe(true);
  });
});

describe('mapBlast — edge cases (the happy path lives in server.test.ts)', () => {
  it('caps caller strings at 10 per symbol, keeping order, and reports callers_total', () => {
    const callers = Array.from({ length: 14 }, (_, i) => ({
      file: `src/c${i}.ts`,
      line: i + 1,
      symbol: `fn${i}`,
      rank: 14 - i, // already rank-desc from the server
    }));
    const resp = {
      ...BLAST_RESPONSE,
      symbols: [{ ...BLAST_RESPONSE.symbols[0]!, callers }],
    };

    const out = mapBlast('acme/payments-api', 482, resp);
    expect(BlastRadiusOutput.parse(out)).toEqual(out);
    expect(out.symbols[0]!.callers).toHaveLength(10);
    expect(out.symbols[0]!.callers_total).toBe(14);
    // Order preserved (server sends rank-desc) + "file:line (caller)" format.
    expect(out.symbols[0]!.callers[0]).toBe('src/c0.ts:1 (fn0)');
    expect(out.symbols[0]!.callers[9]).toBe('src/c9.ts:10 (fn9)');
  });

  it('dedups the endpoint union across files and depths', () => {
    const resp = {
      ...BLAST_RESPONSE,
      endpoints: [
        { endpoint: 'GET /x', file: 'src/a.ts', depth: 1 },
        { endpoint: 'GET /x', file: 'src/b.ts', depth: 2 }, // same route, other file
        { endpoint: 'POST /y', file: 'src/a.ts', depth: 1 },
      ],
    };
    const out = mapBlast('acme/payments-api', 482, resp);
    expect(out.endpoints).toEqual(['GET /x', 'POST /y']);
  });

  it.each(['degraded', 'partial', 'empty'] as const)(
    '%s is a NORMAL result: status + reason mapped, output still conforms',
    (status) => {
      const resp = {
        ...BLAST_RESPONSE,
        status,
        reason: `the index says ${status}.`,
        counts: { symbols: 0, callers: 0, endpoints: 0, crons: 0 },
        symbols: [],
        endpoints: [],
        prior_prs: [],
      };
      const out = mapBlast('acme/payments-api', 482, resp);
      expect(BlastRadiusOutput.parse(out)).toEqual(out);
      expect(out.status).toBe(status);
      expect(out.reason).toBe(`the index says ${status}.`);
      expect(out.symbols).toEqual([]);
      expect(out.endpoints).toEqual([]);
    },
  );

  it('nullish reason maps to undefined (kept out of the payload)', () => {
    const out = mapBlast('acme/payments-api', 482, { ...BLAST_RESPONSE, reason: null });
    expect(out.reason).toBeUndefined();
    expect(BlastRadiusOutput.parse(out)).toEqual(out);
  });
});

describe('mapConventions', () => {
  const resp = {
    conventions: [
      makeConvention({ id: 'c1', status: 'accepted' }),
      makeConvention({ id: 'c2', status: 'pending' }),
      makeConvention({ id: 'c3', status: 'rejected' }),
    ],
    stats: CONVENTIONS_RESPONSE.stats,
  };

  it('defaults to status "all" with snake_case stats', () => {
    const out = mapConventions('acme/payments-api', resp);
    expect(ConventionsOutput.parse(out)).toEqual(out);
    expect(out.conventions.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(out.total).toBe(3);
    expect(out.has_more).toBe(false);
    expect(out.stats).toEqual({
      sampled_file_count: 40,
      dropped_count: 3,
      last_scan_at: '2026-08-20T09:00:00.000Z',
    });
  });

  it('filters by status and applies limit + has_more', () => {
    const out = mapConventions('acme/payments-api', resp, { status: 'pending' });
    expect(out.conventions.map((c) => c.id)).toEqual(['c2']);
    expect(out.total).toBe(1);

    const limited = mapConventions('acme/payments-api', resp, { limit: 2 });
    expect(limited.conventions).toHaveLength(2);
    expect(limited.total).toBe(3);
    expect(limited.has_more).toBe(true);
  });

  it('maps nullish stats to null (pre-first-scan)', () => {
    const out = mapConventions('acme/payments-api', { conventions: [] });
    expect(out.stats).toBeNull();
    expect(out.total).toBe(0);
  });
});
