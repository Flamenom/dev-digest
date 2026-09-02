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
  // L06 eval pipeline — C1..C23 (contracts/eval-pipeline.ts)
  EvalExpectationKind,
  EvalExpectation,
  EvalExpectedOutput,
  EvalPrMeta,
  EvalCaseLastRun,
  EvalCaseRecord,
  EvalActualOutput,
  EvalCaseRunRecord,
  EvalBatchStatus,
  EvalBatchRecord,
  EvalBatchRunInput,
  EvalBatchStarted,
  EvalAgentSummary,
  EvalDashboardOverview,
  EvalAlertSignal,
  EvalAlertDetail,
  EvalAgentDashboard,
  EvalPromptDiffLine,
  EvalCompare,
  EvalPromoteResult,
  EvalCaseFromFindingInput,
  EvalCaseLink,
  EvalRunAllResult,
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

/**
 * L06 — `contracts/eval-pipeline.ts` (spec §2.2). ONE `parse` fixture per new
 * schema C1..C23, so a field renamed on either vendored copy fails here first.
 *
 * Two conventions the fixtures deliberately exercise:
 *  - `.nullish()` keys may be OMITTED ENTIRELY (root INSIGHTS: `.nullable()`
 *    would make them required-but-null and break every builder).
 *  - `.nullable()` metrics (`recall` / `precision` / `citation_accuracy` /
 *    `cost_usd`) are ALWAYS PRESENT and their `null` is the meaningful §4.6
 *    zero-denominator answer — never `NaN`, never a silently-invented number.
 */
describe('L06 eval-pipeline contracts (C1-C23)', () => {
  /** A `must_find` expectation carrying every advisory display field. */
  const richExpectation = {
    file: 'src/config.ts',
    start_line: 11,
    end_line: 12,
    title: 'Hardcoded Stripe secret key',
    severity: 'CRITICAL',
    category: 'security',
  };
  /** The minimum an expectation can be — advisory metadata omitted, not nulled. */
  const bareExpectation = { file: 'src/util.ts', start_line: 40 };

  const finding = {
    id: 'f1',
    severity: 'CRITICAL',
    category: 'security',
    title: 'Hardcoded Stripe secret key in commit',
    file: 'src/config.ts',
    start_line: 11,
    end_line: 11,
    rationale: 'Line 11 contains a literal `sk_live_` Stripe key.',
    confidence: 0.98,
    kind: 'secret_leak',
  };

  const batch = {
    batch_id: 'b1',
    agent_id: 'a1',
    agent_name: 'Security Reviewer',
    agent_version: 7,
    ran_at: '2026-09-02T10:00:00.000Z',
    status: 'complete',
    recall: 0.8,
    precision: 0.9,
    citation_accuracy: 1,
    cases_total: 10,
    cases_passed: 8,
    cases_failed: 2,
    cases_errored: 0,
    must_find_total: 5,
    must_find_matched: 4,
    must_not_flag_total: 5,
    noise_findings: 1,
    findings_total: 10,
    grounding_kept: 9,
    grounding_total: 9,
    duration_ms: 41000,
    cost_usd: 0.42,
  };

  const dashboard = {
    owner_kind: 'agent',
    owner_id: 'a1',
    cases_total: 10,
    current: {
      recall: 0.8,
      precision: 0.9,
      citation_accuracy: 1,
      traces_passed: 8,
      traces_total: 10,
      cost_usd: 0.42,
    },
    delta: { recall: 0.1, precision: -0.02, citation_accuracy: 0 },
    trend: [
      {
        ran_at: '2026-09-01T10:00:00.000Z',
        recall: 0.7,
        precision: 0.92,
        citation_accuracy: 1,
        pass_rate: 0.7,
        cost_usd: 0.4,
      },
    ],
    recent_runs: [],
    alert: 'Recall improved by 10 pts since the previous batch.',
  };

  const agent = {
    id: 'a1',
    name: 'Security Reviewer',
    description: 'Finds secrets and injection.',
    provider: 'openrouter',
    model: 'google/gemini-2.5-flash-lite',
    system_prompt: 'You are a security reviewer.',
    enabled: true,
    version: 10,
    strategy: 'single-pass',
    ci_fail_on: 'critical',
    repo_intel: true,
    attached_doc_paths: [],
  };

  it('C1-C4: expectation kind, expectation, expected_output wrapper, PR meta', () => {
    expect(EvalExpectationKind.parse('must_find')).toBe('must_find');
    expect(EvalExpectationKind.parse('must_not_flag')).toBe('must_not_flag');
    // D2 — one case, one kind; there is no third kind.
    expect(EvalExpectationKind.safeParse('should_find').success).toBe(false);

    expect(EvalExpectation.parse(richExpectation).severity).toBe('CRITICAL');
    // Advisory metadata is `.nullish()` — omitting it must parse (§4.3: it takes
    // no part in the match rule anyway).
    const bare = EvalExpectation.parse(bareExpectation);
    expect(bare.end_line ?? null).toBeNull();
    expect(bare.title ?? null).toBeNull();
    // `severity` / `category` reuse the frozen enums rather than redefining them.
    expect(
      EvalExpectation.safeParse({ ...richExpectation, severity: 'BLOCKER' }).success,
    ).toBe(false);
    expect(EvalExpectation.safeParse({ ...richExpectation, category: 'ux' }).success).toBe(false);
    // `file` is the match key — an empty one is never a valid expectation.
    expect(EvalExpectation.safeParse({ file: '', start_line: 1 }).success).toBe(false);

    const expected = EvalExpectedOutput.parse({
      kind: 'must_find',
      expectations: [richExpectation, bareExpectation],
    });
    expect(expected.expectations).toHaveLength(2);
    expect(EvalExpectedOutput.parse({ kind: 'must_not_flag', expectations: [] }).kind).toBe(
      'must_not_flag',
    );

    expect(
      EvalPrMeta.parse({
        title: 'Add rate limiting',
        body: 'Closes #471',
        number: 482,
        author: 'octocat',
        base: 'main',
        branch: 'feat/rate-limit',
      }).number,
    ).toBe(482);
    // Every C4 field is `.nullish()`: an empty meta blob is legal.
    expect(EvalPrMeta.parse({})).toEqual({});
  });

  it('C5-C6: last-run strip and the case record extending the frozen EvalCase', () => {
    const lastRun = EvalCaseLastRun.parse({
      run_id: 'r1',
      ran_at: '2026-09-02T10:00:00.000Z',
      pass: null, // errored / not yet judged — nullable, not optional
      expected_count: 2,
      produced_count: 3,
      duration_ms: 4100,
      cost_usd: 0.02,
    });
    expect(lastRun.pass).toBeNull();
    // `pass` is `.nullable()`, so the key must be PRESENT.
    expect(
      EvalCaseLastRun.safeParse({
        run_id: 'r1',
        ran_at: '2026-09-02T10:00:00.000Z',
        expected_count: 0,
        produced_count: 0,
      }).success,
    ).toBe(false);

    const full = EvalCaseRecord.parse({
      id: 'c1',
      owner_kind: 'agent',
      owner_id: 'a1',
      name: 'hardcoded-stripe-secret',
      input_diff: '--- a/src/config.ts\n+++ b/src/config.ts\n@@ -10,2 +10,3 @@\n+const k = 1;\n',
      input_files: null,
      input_meta: { title: 'Add rate limiting', body: null },
      expected_output: { kind: 'must_find', expectations: [richExpectation] },
      notes: 'born from an accepted finding',
      source_finding_id: 'f1',
      last_run: lastRun,
      diff_warnings: [],
    });
    // C6 NARROWS the frozen `z.unknown()` blobs to concrete shapes.
    expect(full.expected_output.kind).toBe('must_find');
    expect(full.input_meta.title).toBe('Add rate limiting');
    expect(full.source_finding_id).toBe('f1');

    // A seeded case: no source finding, never run, one editor warning (AC-13).
    const seeded = EvalCaseRecord.parse({
      id: 'c2',
      owner_kind: 'agent',
      owner_id: 'a1',
      name: 'no-op-refactor',
      input_diff: 'diff',
      input_files: null,
      input_meta: {},
      expected_output: { kind: 'must_not_flag', expectations: [bareExpectation] },
      diff_warnings: ['Expectation 1 targets src/util.ts:40, which no hunk of this diff covers.'],
    });
    expect(seeded.source_finding_id ?? null).toBeNull();
    expect(seeded.last_run ?? null).toBeNull();

    // The narrowing is real: a blob that is not an EvalExpectedOutput is rejected.
    expect(
      EvalCaseRecord.safeParse({ ...full, expected_output: { kind: 'maybe_find', expectations: [] } })
        .success,
    ).toBe(false);
  });

  it('C7-C8: the actual_output blob and the per-case run row', () => {
    const actual = EvalActualOutput.parse({
      findings: [finding],
      pre_gate_count: 4,
      grounding_kept: 3,
      grounding_total: 4,
      grounding_dropped: [{ title: 'Phantom nit', reason: 'cited line not in diff' }],
      matched_expectations: 1,
      noise_findings: 0,
      case_fingerprint: 'a1b2c3d4e5f60718',
      expectation_kind: 'must_find',
    });
    // §4.5 invariant, true only because the runner never passes `intent`.
    expect(actual.grounding_kept + actual.grounding_dropped.length).toBe(actual.grounding_total);
    expect(actual.error ?? null).toBeNull();

    // AC-47/AC-48 — the errored shape: no findings, zero counters, an error tag.
    const errored = EvalActualOutput.parse({
      findings: [],
      pre_gate_count: 0,
      grounding_kept: 0,
      grounding_total: 0,
      grounding_dropped: [],
      matched_expectations: 0,
      noise_findings: 0,
      case_fingerprint: 'a1b2c3d4e5f60718',
      expectation_kind: 'must_not_flag',
      error: 'empty_diff',
    });
    expect(errored.error).toBe('empty_diff');

    const run = EvalCaseRunRecord.parse({
      id: 'r1',
      case_id: 'c1',
      case_name: 'hardcoded-stripe-secret',
      ran_at: '2026-09-02T10:00:00.000Z',
      actual_output: actual,
      pass: true,
      recall: 1,
      precision: null, // zero denominator (§4.6) — null, never NaN
      citation_accuracy: 0.75,
      duration_ms: 4100,
      cost_usd: null, // AC-49: no usage reported
      batch_id: 'b1',
      agent_version: 7,
    });
    expect(run.precision).toBeNull();
    expect(run.batch_id).toBe('b1');

    // A pre-0018 row: the three added columns are `.nullish()` and may be absent (§3).
    const legacy = EvalCaseRunRecord.parse({
      id: 'r0',
      case_id: 'c1',
      ran_at: '2026-01-01T00:00:00.000Z',
      actual_output: null,
      pass: null,
      recall: null,
      precision: null,
      citation_accuracy: null,
      duration_ms: null,
      cost_usd: null,
    });
    expect(legacy.batch_id ?? null).toBeNull();
    expect(legacy.agent_version ?? null).toBeNull();
  });

  it('C9-C12: batch status, batch record, run input and the 202 body', () => {
    expect(EvalBatchStatus.options).toEqual(['running', 'complete', 'failed']);
    expect(EvalBatchStatus.safeParse('pending').success).toBe(false);

    expect(EvalBatchRecord.parse(batch).cases_total).toBe(10);
    // A running batch with no numbers yet — every metric null, denominators zero.
    const running = EvalBatchRecord.parse({
      ...batch,
      status: 'running',
      recall: null,
      precision: null,
      citation_accuracy: null,
      cases_passed: 0,
      cases_failed: 0,
      cases_errored: 0,
      must_find_total: 0,
      must_find_matched: 0,
      must_not_flag_total: 0,
      noise_findings: 0,
      findings_total: 0,
      grounding_kept: 0,
      grounding_total: 0,
      duration_ms: 0,
      cost_usd: null,
    });
    expect(running.recall).toBeNull();
    // The metrics are `.nullable()`, so their keys are REQUIRED — an aggregator
    // that forgets one must not silently ship an undefined metric.
    const { recall: _dropped, ...noRecall } = batch;
    expect(EvalBatchRecord.safeParse(noRecall).success).toBe(false);
    // `agent_version` is `.nullish()` (pre-0018 rows) and may be omitted.
    const { agent_version: _v, ...noVersion } = batch;
    expect(EvalBatchRecord.safeParse(noVersion).success).toBe(true);

    // C11 — omit `case_ids` ⇒ every case of the agent.
    expect(EvalBatchRunInput.parse({})).toEqual({});
    expect(EvalBatchRunInput.parse({ case_ids: ['c1', 'c2'] }).case_ids).toHaveLength(2);

    expect(
      EvalBatchStarted.parse({
        batch_id: 'b1',
        agent_id: 'a1',
        agent_version: 7,
        cases_total: 10,
      }).cases_total,
    ).toBe(10);
  });

  it('C13-C14: the /evals overview — agent row-cards + recent batches', () => {
    const summary = EvalAgentSummary.parse({
      agent_id: 'a1',
      name: 'Security Reviewer',
      model: 'google/gemini-2.5-flash-lite',
      version: 7,
      enabled: true,
      cases_total: 10,
      last_batch: batch,
      sparkline: [0.6, 0.7, 0.8],
    });
    expect(summary.last_batch?.batch_id).toBe('b1');

    // An agent that has cases but has never completed a batch (§8.2).
    const neverRun = EvalAgentSummary.parse({
      agent_id: 'a2',
      name: 'Perf Reviewer',
      model: 'gpt-4.1',
      version: 1,
      enabled: false,
      cases_total: 0,
      last_batch: null,
      sparkline: [],
    });
    expect(neverRun.last_batch).toBeNull();

    const overview = EvalDashboardOverview.parse({
      agents: [summary, neverRun],
      recent_batches: [batch],
    });
    expect(overview.agents).toHaveLength(2);
    expect(EvalDashboardOverview.parse({ agents: [], recent_batches: [] }).agents).toEqual([]);
  });

  it('C15-C17: alert signal, alert detail and the per-agent dashboard', () => {
    const primary = EvalAlertSignal.parse({ metric: 'precision', direction: 'down', delta_pts: -7 });
    expect(primary.delta_pts).toBe(-7);
    // §8.4 rounds HALF AWAY FROM ZERO to an integer — a fractional point count
    // means the producer skipped the rounding step.
    expect(EvalAlertSignal.safeParse({ ...primary, delta_pts: -7.5 }).success).toBe(false);
    expect(EvalAlertSignal.safeParse({ ...primary, metric: 'pass_rate' }).success).toBe(false);
    expect(EvalAlertSignal.safeParse({ ...primary, direction: 'flat' }).success).toBe(false);

    const alert = EvalAlertDetail.parse({
      tone: 'warn',
      primary,
      others: [{ metric: 'recall', direction: 'up', delta_pts: 3 }],
      new_false_positive: true,
      head_version: 8,
    });
    expect(alert.others).toHaveLength(1);
    // `head_version` is `.nullish()`; `others` may be empty.
    expect(
      EvalAlertDetail.parse({ tone: 'info', primary, others: [], new_false_positive: false })
        .head_version ?? null,
    ).toBeNull();

    const agentDashboard = EvalAgentDashboard.parse({
      agent: {
        id: 'a1',
        name: 'Security Reviewer',
        model: 'google/gemini-2.5-flash-lite',
        version: 7,
        provider: 'openrouter',
      },
      window_days: 30,
      dashboard,
      batches: [batch],
      alert,
    });
    expect(agentDashboard.dashboard.current.recall).toBe(0.8);
    // `window_days: null` = all time; `alert: null` = fewer than two complete
    // batches in the window. Both are meaningful nulls, so both keys are required.
    expect(
      EvalAgentDashboard.parse({ ...agentDashboard, window_days: null, alert: null }).alert,
    ).toBeNull();
    expect(
      EvalAgentDashboard.safeParse({
        ...agentDashboard,
        agent: { ...agentDashboard.agent, provider: 'ollama' },
      }).success,
    ).toBe(false);
  });

  it('C18-C20: prompt diff line, compare payload and promote result', () => {
    expect(EvalPromptDiffLine.parse({ kind: 'added', text: '+ Always cite the line.' }).kind).toBe(
      'added',
    );
    expect(EvalPromptDiffLine.safeParse({ kind: 'changed', text: 'x' }).success).toBe(false);

    const compare = EvalCompare.parse({
      base: batch,
      head: { ...batch, batch_id: 'b2', agent_version: 8, recall: 0.9 },
      deltas: { recall: 0.1, precision: null, citation_accuracy: 0, cost_usd: -0.01 },
      comparable: true,
      changed_case_ids: [],
      prompt_diff: [
        { kind: 'context', text: 'You are a security reviewer.' },
        { kind: 'removed', text: 'Be brief.' },
        { kind: 'added', text: 'Always cite the exact changed line.' },
      ],
      prompt_diff_available: true,
      promote_target_version: 7,
    });
    // A delta is null when EITHER side is null — the card renders `—`, not 0.
    expect(compare.deltas.precision).toBeNull();
    expect(compare.prompt_diff).toHaveLength(3);

    // AC-33 — the case set changed between the two batches, so the deltas are
    // not like-for-like and `changed_case_ids` names the culprits.
    const incomparable = EvalCompare.parse({
      ...compare,
      comparable: false,
      changed_case_ids: ['c1', 'c4'],
      prompt_diff: [],
      prompt_diff_available: false,
      promote_target_version: null,
    });
    expect(incomparable.changed_case_ids).toEqual(['c1', 'c4']);
    expect(incomparable.promote_target_version).toBeNull();

    const promoted = EvalPromoteResult.parse({
      agent,
      promoted_from_version: 7,
      new_version: 10,
      changed: true,
    });
    expect(promoted.agent.provider).toBe('openrouter');
    // AC-32 — an identical config creates nothing; `new_version` is the
    // unchanged current version and `changed` is false.
    expect(
      EvalPromoteResult.parse({
        agent,
        promoted_from_version: 10,
        new_version: 10,
        changed: false,
      }).changed,
    ).toBe(false);
  });

  it('C21-C23: from-finding input, the PR-page case links and run-all', () => {
    // A bare click sends no name at all (§7 auto-slugifies the finding title).
    expect(EvalCaseFromFindingInput.parse({})).toEqual({});
    expect(EvalCaseFromFindingInput.parse({ name: 'my-case' }).name).toBe('my-case');

    expect(
      EvalCaseLink.parse({ finding_id: 'f1', case_id: 'c1', case_name: 'hardcoded-stripe-secret' })
        .case_name,
    ).toBe('hardcoded-stripe-secret');

    const runAll = EvalRunAllResult.parse({
      started: [{ batch_id: 'b1', agent_id: 'a1', agent_version: 7, cases_total: 10 }],
      skipped: [
        { agent_id: 'a2', agent_name: 'Perf Reviewer', reason: 'no_cases' },
        { agent_id: 'a3', agent_name: 'Style Reviewer', reason: 'already_running' },
        { agent_id: 'a4', agent_name: 'Old Reviewer', reason: 'disabled' },
      ],
    });
    expect(runAll.skipped.map((s) => s.reason)).toEqual([
      'no_cases',
      'already_running',
      'disabled',
    ]);
    // AC-34 — the three reasons are a CLOSED set; an unexplained skip is a bug.
    expect(
      EvalRunAllResult.safeParse({
        started: [],
        skipped: [{ agent_id: 'a5', agent_name: 'X', reason: 'rate_limited' }],
      }).success,
    ).toBe(false);
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
