import { describe, it, expect } from 'vitest';
import {
  Review,
  Finding,
  Intent,
  BlastRadius,
  Risks,
  PrHistory,
  SmartDiff,
  Conformance,
  Onboarding,
  EvalRun,
  MemoryItem,
  RunTrace,
  Settings,
  Repo,
  PrDetail,
  IntentDetail,
  ScopedReview,
  PrBriefDetail,
  PrBriefGeneration,
} from '@devdigest/shared';

/**
 * Contract tests — parse/round-trip the fixtures from data.jsx/data2.jsx
 * so feature agents can rely on the schemas matching the prototype data.
 */
describe('AI contracts parse fixtures', () => {
  it('Review + Finding (data.jsx VERDICT/FINDINGS)', () => {
    const review = Review.parse({
      verdict: 'request_changes',
      summary: 'Two blockers before merge.',
      score: 61,
      findings: [
        {
          id: 'f1',
          severity: 'CRITICAL',
          category: 'security',
          title: 'Hardcoded Stripe secret key in commit',
          file: 'src/config.ts',
          start_line: 12,
          end_line: 12,
          rationale: 'Line 12 contains a literal `sk_live_` Stripe key.',
          suggestion: 'Move to env and rotate.',
          confidence: 0.98,
          kind: 'secret_leak',
        },
      ],
    });
    expect(review.findings).toHaveLength(1);
    expect(review.score).toBe(61);
  });

  it('lethal-trifecta Finding variant', () => {
    const f = Finding.parse({
      id: 'f2',
      severity: 'CRITICAL',
      category: 'security',
      title: 'Lethal trifecta',
      file: 'src/api/public/webhooks.ts',
      start_line: 61,
      end_line: 74,
      rationale: 'all three legs present',
      confidence: 0.79,
      kind: 'lethal_trifecta',
      trifecta_components: ['private_data_access', 'untrusted_input', 'exfil_path'],
      evidence: [{ component: 'untrusted_input', file: 'src/api/public/webhooks.ts', line: 61 }],
    });
    expect(f.trifecta_components).toContain('exfil_path');
  });

  it('Intent / BlastRadius / Risks / PrHistory', () => {
    expect(() =>
      Intent.parse({ intent: 'x', in_scope: ['a'], out_of_scope: ['b'] }),
    ).not.toThrow();
    expect(() =>
      BlastRadius.parse({
        changed_symbols: [{ name: 'rateLimit', file: 'a.ts', kind: 'function' }],
        downstream: [
          {
            symbol: 'rateLimit',
            callers: [{ name: 'publicRouter', file: 'b.ts', line: 23 }],
            endpoints_affected: ['GET /x'],
            crons_affected: ['c'],
          },
        ],
        summary: 's',
      }),
    ).not.toThrow();
    expect(() =>
      Risks.parse({
        risks: [{ kind: 'security', title: 't', explanation: 'e', severity: 'high', file_refs: [] }],
      }),
    ).not.toThrow();
    expect(() =>
      PrHistory.parse({
        history: [
          {
            pr_number: 401,
            title: 't',
            merged_at: '2026-03-18',
            author: 'a',
            files_overlap: [],
            notes: 'n',
          },
        ],
      }),
    ).not.toThrow();
  });

  it('SmartDiff (data.jsx DIFF)', () => {
    const d = SmartDiff.parse({
      groups: [
        {
          role: 'core',
          files: [{ path: 'a.ts', additions: 84, deletions: 0, finding_lines: [28, 52] }],
        },
      ],
      split_suggestion: { too_big: false, total_lines: 285, proposed_splits: [] },
    });
    expect(d.groups[0]!.role).toBe('core');
  });

  it('Conformance / Onboarding / EvalRun / MemoryItem', () => {
    expect(() =>
      Conformance.parse({
        spec_id: 's1',
        spec_title: 'Spec',
        items: [{ requirement: 'r', status: 'implemented' }],
        completeness_pct: 80,
      }),
    ).not.toThrow();
    expect(() =>
      Onboarding.parse({
        sections: [{ kind: 'architecture', title: 'T', body: 'b', links: [] }],
      }),
    ).not.toThrow();
    expect(() =>
      EvalRun.parse({
        recall: 0.82,
        precision: 0.91,
        citation_accuracy: 0.95,
        traces_passed: 17,
        traces_total: 20,
        duration_ms: 12000,
        cost_usd: 0.23,
        per_trace: [{ name: 't01', pass: true, expected: 'x', actual: 'x' }],
      }),
    ).not.toThrow();
    expect(() =>
      MemoryItem.parse({
        content: 'c',
        scope: 'team',
        kind: 'decision',
        confidence: 0.92,
        sources: [{ pr: 401, context: 'ctx' }],
      }),
    ).not.toThrow();
  });

  it('IntentDetail (L03) — full row and one with nullish keys omitted', () => {
    // Frozen Intent's summary field is named `intent` (contracts/brief.ts).
    const full = IntentDetail.parse({
      pr_id: '3e2a2b52-3b8c-4b34-9a34-0a4c8e2b1c11',
      intent: 'Introduce per-IP rate limiting on the public API endpoints.',
      in_scope: ['Token-bucket middleware'],
      out_of_scope: ['Auth changes'],
      risk_areas: ['New dependency: ioredis'],
      confidence: 'high',
      sources: [
        { kind: 'pr_description', ref: 'PR description', status: 'fetched' },
        { kind: 'linked_issue', ref: '#471', title: 'Rate limit API', status: 'fetched' },
        { kind: 'external_url', ref: 'https://example.com/doc', status: 'unavailable' },
      ],
      model: 'google/gemini-2.5-flash-lite',
      head_sha: 'a1b2c3d4',
      generated_at: '2026-08-21T00:00:00.000Z',
      stale: false,
    });
    expect(full.intent).toContain('rate limiting');
    expect(full.sources).toHaveLength(3);

    // `.nullish()` keys (model, head_sha, source title) may be OMITTED entirely.
    expect(() =>
      IntentDetail.parse({
        pr_id: 'pr-1',
        intent: 'x',
        in_scope: [],
        out_of_scope: [],
        risk_areas: [],
        confidence: 'low',
        sources: [{ kind: 'repo_doc', ref: 'docs/a.md', status: 'unavailable' }],
        generated_at: '2026-08-21T00:00:00.000Z',
        stale: true,
      }),
    ).not.toThrow();

    // confidence/status are closed enums.
    expect(
      IntentDetail.safeParse({
        pr_id: 'pr-1',
        intent: 'x',
        in_scope: [],
        out_of_scope: [],
        risk_areas: [],
        confidence: 'medium',
        sources: [],
        generated_at: '2026-08-21T00:00:00.000Z',
        stale: false,
      }).success,
    ).toBe(false);
  });

  it('ScopedReview (L03) — findings may carry scope in/out or omit it', () => {
    const finding = {
      id: 'f1',
      severity: 'CRITICAL',
      category: 'security',
      title: 'Hardcoded secret',
      file: 'src/config.ts',
      start_line: 11,
      end_line: 11,
      rationale: 'literal key in diff',
      confidence: 0.98,
      kind: 'finding',
    };
    const review = ScopedReview.parse({
      verdict: 'request_changes',
      summary: 's',
      score: 40,
      findings: [
        { ...finding, scope: 'out' },
        { ...finding, id: 'f2', scope: 'in' },
        { ...finding, id: 'f3' }, // scope is nullish — may be omitted
      ],
    });
    expect(review.findings.map((f) => f.scope ?? null)).toEqual(['out', 'in', null]);

    expect(
      ScopedReview.safeParse({
        verdict: 'approve',
        summary: 's',
        score: 100,
        findings: [{ ...finding, scope: 'sideways' }],
      }).success,
    ).toBe(false);
  });

  it('PrBriefDetail — full card payload round-trips; nullish provenance may be omitted', () => {
    const full = PrBriefDetail.parse({
      pr_id: '3e2a2b52-3b8c-4b34-9a34-0a4c8e2b1c11',
      what: 'Adds a per-IP token-bucket limiter to the public API endpoints.',
      why: 'Unbounded traffic has been exhausting the upstream provider quota.',
      risks: [
        {
          kind: 'security',
          title: 'Hardcoded Stripe secret key',
          explanation: 'A live key is introduced alongside the limiter settings.',
          severity: 'high',
          refs: [{ path: 'src/config.ts', start_line: 11, end_line: 11 }],
        },
      ],
      review_focus: [
        {
          path: 'src/config.ts',
          line: 11,
          reason: 'The secret is introduced on this line.',
          finding_id: 'f1',
        },
      ],
      score: 61,
      risk_level: 'medium',
      status: 'request_changes',
      findings_count: 3,
      blockers: 2,
      cost_usd: 0.061,
      tokens_in: 3600,
      tokens_out: 400,
      missing_inputs: [{ input: 'blast_radius', reason: 'the repository is not indexed' }],
      model: 'gpt-4.1',
      head_sha: 'a1b2c3d4',
      generated_at: '2026-08-27T00:00:00.000Z',
      stale: false,
      stale_reason: null,
      generation: { state: 'ok', reason: null },
    });
    expect(full.risks[0]!.refs[0]!.path).toBe('src/config.ts');
    expect(full.review_focus[0]!.finding_id).toBe('f1');

    // The degraded shape the card must still render: no content, no provenance,
    // full deterministic header (AC-18a, AC-36). `.nullish()` keys may be OMITTED.
    const skeleton = PrBriefDetail.parse({
      pr_id: 'pr-1',
      what: null,
      why: null,
      risks: [],
      review_focus: [],
      score: null,
      risk_level: null,
      status: 'not_reviewed',
      findings_count: 0,
      blockers: 0,
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      missing_inputs: [],
      stale: false,
      stale_reason: null,
      generation: { state: 'not_generated', reason: 'nothing generated yet' },
    });
    expect(skeleton.model ?? null).toBeNull();

    // `status` and `generation.state` are closed enums.
    expect(
      PrBriefDetail.safeParse({
        ...full,
        status: 'merged',
      }).success,
    ).toBe(false);
    expect(
      PrBriefDetail.safeParse({
        ...full,
        generation: { state: 'pending', reason: null },
      }).success,
    ).toBe(false);
  });

  it('PrBriefGeneration — AC-14 caps are enforced by the schema, so an over-cap answer never parses', () => {
    const risk = {
      kind: 'security',
      title: 'Risk',
      explanation: 'Short enough.',
      severity: 'low',
      refs: [{ path: 'src/config.ts', start_line: 11 }],
    };
    const entry = { path: 'src/config.ts', line: 11, reason: 'Read this first.' };

    // A response at the caps parses.
    expect(
      PrBriefGeneration.safeParse({
        what: 'x'.repeat(400),
        why: 'y'.repeat(400),
        risks: Array.from({ length: 6 }, () => risk),
        review_focus: Array.from({ length: 8 }, () => entry),
      }).success,
    ).toBe(true);

    // Each cap, one past its limit — every one is a PARSE FAILURE, never a trim.
    const over: [string, unknown][] = [
      ['7 risks', { what: 'w', why: 'y', risks: Array.from({ length: 7 }, () => risk), review_focus: [] }],
      ['9 focus entries', { what: 'w', why: 'y', risks: [], review_focus: Array.from({ length: 9 }, () => entry) }],
      ['401-char what', { what: 'x'.repeat(401), why: 'y', risks: [], review_focus: [] }],
      ['401-char why', { what: 'w', why: 'y'.repeat(401), risks: [], review_focus: [] }],
      ['81-char risk title', { what: 'w', why: 'y', risks: [{ ...risk, title: 't'.repeat(81) }], review_focus: [] }],
      ['301-char explanation', { what: 'w', why: 'y', risks: [{ ...risk, explanation: 'e'.repeat(301) }], review_focus: [] }],
      ['161-char reason', { what: 'w', why: 'y', risks: [], review_focus: [{ ...entry, reason: 'r'.repeat(161) }] }],
    ];
    for (const [label, payload] of over) {
      expect(PrBriefGeneration.safeParse(payload).success, label).toBe(false);
    }

    // [D1] — the model contributes no number: a `score` it invents is stripped,
    // never carried into the persisted content.
    const stripped = PrBriefGeneration.parse({
      what: 'w',
      why: 'y',
      risks: [],
      review_focus: [],
      score: 42,
      risk_level: 'low',
    });
    expect(stripped).toEqual({ what: 'w', why: 'y', risks: [], review_focus: [] });
  });

  it('RunTrace (data2.jsx TRACE single-document)', () => {
    const trace = RunTrace.parse({
      config: { agent: 'Security Reviewer', version: 'v7', model: 'gpt-4.1', pr: 482, source: 'local' },
      stats: { duration_ms: 8200, tokens_in: 14820, tokens_out: 1240, cost_usd: 0.06, findings: 3, grounding: '3/3 passed' },
      prompt_assembly: { system: 's', user: 'u' },
      tool_calls: [{ tool: 'read_file', args: "'src/config.ts'", meta: '1,240 bytes', ms: 120 }],
      raw_output: '{}',
      memory_pulled: [{ pr: 288, text: 'verified via stripe-signature' }],
      specs_read: ['specs/security-baseline.md'],
      log: [{ t: '00.00', kind: 'info', msg: 'started' }],
    });
    expect(trace.tool_calls).toHaveLength(1);
  });
});

describe('platform DTOs', () => {
  it('Settings defaults + passthrough', () => {
    const s = Settings.parse({ extra_key: 'x' });
    expect(s.theme).toBe('dark');
    expect((s as Record<string, unknown>).extra_key).toBe('x');
  });

  it('Repo + PrDetail', () => {
    expect(() =>
      Repo.parse({
        id: 'r1',
        workspace_id: 'w1',
        owner: 'acme',
        name: 'payments-api',
        full_name: 'acme/payments-api',
        default_branch: 'main',
        clone_path: null,
        last_polled_at: null,
        created_by: null,
      }),
    ).not.toThrow();
    expect(() =>
      PrDetail.parse({
        number: 482,
        title: 't',
        author: 'a',
        branch: 'b',
        base: 'main',
        head_sha: 'sha',
        additions: 1,
        deletions: 0,
        files_count: 1,
        status: 'open',
        files: [],
        commits: [],
      }),
    ).not.toThrow();
  });
});
