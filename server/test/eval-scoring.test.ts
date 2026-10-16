/**
 * L06 Eval Pipeline — the PURE matrix: the whole of spec §4 (scoring, metrics,
 * fingerprint), §7/AC-8 (case naming), §8.4 (alert rules) and §9.1 (prompt
 * diff), plus the §14 upper-bound timing.
 *
 * HERMETIC BY CONSTRUCTION (AC-36's observable). The import graph of this file
 * is exactly: the five pure `modules/eval/*` modules and the vendored Zod
 * contracts. No provider, no container, no `db`, no adapter, no Fastify — and
 * therefore no Postgres, no network and no API key are needed to run it. The
 * file name deliberately carries no `.it.` segment, which is what routes a
 * server test to testcontainers (`server/CLAUDE.md`).
 *
 * Fixtures are built THROUGH the contract schemas (`EvalExpectation.parse`,
 * `EvalExpectedOutput.parse`, `EvalAlertDetail.parse`,
 * `z.array(EvalPromptDiffLine).parse`) rather than as bare literals, so a drift
 * in `contracts/eval-pipeline.ts` breaks this test instead of silently changing
 * what the harness measures.
 *
 * Two implementation decisions are pinned here AS IMPLEMENTED, because both are
 * load-bearing and neither is obvious from the formulas alone:
 *
 *  1. `aggregateBatch` excludes ERRORED and PENDING rows from every numerator
 *     AND every denominator (§4.4 + AC-48). An infrastructure failure must
 *     never read as an agent regression. Errored rows still count in
 *     `cases_errored`, so nothing is hidden — see the `AC-48` block.
 *  2. `slugifyCaseName` re-trims a trailing `-` AFTER the 48-char cap, so a
 *     capped slug never composes into `foo--2` on collision — see the
 *     `slugifyCaseName` block. The behaviour is asserted, not the step order.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  EvalAlertDetail,
  EvalExpectation,
  EvalExpectedOutput,
  EvalPromptDiffLine,
} from '@devdigest/shared';
import {
  aggregateBatch,
  canonicalJson,
  caseFingerprint,
  intervalsIntersect,
  matches,
  normalizePath,
  parseExpectedOutput,
  scoreCase,
  type BatchScoreRow,
  type CaseOutcome,
  type MatchableFinding,
  type ScoredCase,
} from '../src/modules/eval/scoring.js';
import {
  ALERT_METRIC_PRIORITY,
  alertFallbackSentence,
  buildAlert,
  deltaPoints,
  type AlertBatchInput,
} from '../src/modules/eval/alerts.js';
import {
  FALLBACK_CASE_SLUG,
  MAX_CASE_SLUG_LENGTH,
  nextFreeName,
  slugifyCaseName,
} from '../src/modules/eval/naming.js';
import {
  MAX_PROMPT_DIFF_LINES,
  PROMPT_DIFF_CONTEXT_LINES,
  promptDiff,
} from '../src/modules/eval/prompt-diff.js';
import { ALERT_THRESHOLD_PTS } from '../src/modules/eval/constants.js';

// ===========================================================================
// Builders — everything that can go through a contract schema, does
// ===========================================================================

/** An expectation, validated by C2 so a contract drift breaks the fixture. */
const exp = (over: {
  file: string;
  start_line: number;
  end_line?: number | null;
  title?: string | null;
  severity?: string | null;
  category?: string | null;
}): EvalExpectation => EvalExpectation.parse(over);

/** An `expected_output` blob, validated by C3. */
const expectedOutput = (
  kind: 'must_find' | 'must_not_flag',
  expectations: readonly EvalExpectation[],
): EvalExpectedOutput => EvalExpectedOutput.parse({ kind, expectations });

/** A produced finding, reduced to the three fields the match rule reads. */
const found = (file: string, start_line: number, end_line = start_line): MatchableFinding => ({
  file,
  start_line,
  end_line,
});

const outcome = (over: Partial<CaseOutcome> = {}): CaseOutcome => ({
  findings: [],
  droppedCount: 0,
  ...over,
});

const ZERO_ROW: BatchScoreRow = {
  must_find_total: 0,
  must_find_matched: 0,
  must_not_flag_total: 0,
  noise_findings: 0,
  findings_total: 0,
  grounding_kept: 0,
  grounding_total: 0,
  pass: true,
  finished: true,
};

const row = (over: Partial<BatchScoreRow>): BatchScoreRow => ({ ...ZERO_ROW, ...over });

const finished = (scored: ScoredCase): BatchScoreRow => ({ ...scored, finished: true });

const batch = (over: Partial<AlertBatchInput> = {}): AlertBatchInput => ({
  recall: 0.8,
  precision: 0.8,
  citation_accuracy: 0.8,
  noise_findings: 0,
  ...over,
});

// ===========================================================================
// §4.1 — path normalization
// ===========================================================================

describe('§4.1 normalizePath', () => {
  it('applies the six-step pipeline, each step observable on its own', () => {
    // 1 — Windows separators pasted from a local checkout.
    expect(normalizePath('src\\config.ts')).toBe('src/config.ts');
    expect(normalizePath('a\\b\\c\\d.ts')).toBe('b/c/d.ts');
    // 2 — surrounding whitespace from a copy-paste into the JSON editor.
    expect(normalizePath('   src/config.ts\t\n')).toBe('src/config.ts');
    // 3 — ONE leading git diff prefix.
    expect(normalizePath('a/src/x.ts')).toBe('src/x.ts');
    expect(normalizePath('b/src/x.ts')).toBe('src/x.ts');
    // 4 — leading `./`, repeatedly.
    expect(normalizePath('./src/x.ts')).toBe('src/x.ts');
    expect(normalizePath('././././src/x.ts')).toBe('src/x.ts');
    // 5 — runs of `/` collapsed to one, anywhere in the path.
    expect(normalizePath('src//deep///nested////x.ts')).toBe('src/deep/nested/x.ts');
    // 6 — a leading separator.
    expect(normalizePath('/src/x.ts')).toBe('src/x.ts');
    expect(normalizePath('//src/x.ts')).toBe('src/x.ts');
  });

  it('strips the `a/` / `b/` prefix ONLY when the remainder is non-empty', () => {
    // The whole path IS the prefix — stripping it would erase the path.
    expect(normalizePath('a/')).toBe('a/');
    expect(normalizePath('b/')).toBe('b/');
    // …and exactly one prefix is stripped, never two.
    expect(normalizePath('a/b/c.ts')).toBe('b/c.ts');
    expect(normalizePath('b/b/c.ts')).toBe('b/c.ts');
  });

  it('never treats a same-named directory as a prefix', () => {
    // `a` and `b` are legitimate directory names; only the `a/`+rest form goes.
    expect(normalizePath('src/a/x.ts')).toBe('src/a/x.ts');
    expect(normalizePath('ab/x.ts')).toBe('ab/x.ts');
    expect(normalizePath('a.ts')).toBe('a.ts');
  });

  it('is order-dependent by design: the prefix strip runs BEFORE the `./` strip', () => {
    // `./a/x.ts` does not start with `a/`, so step 3 is a no-op and step 4
    // reveals an `a/` that is then kept. Spec §4.1 fixes this order; the
    // expectation side is hand-editable JSON, so the behaviour is pinned here.
    expect(normalizePath('./a/x.ts')).toBe('a/x.ts');
  });

  it('composes every step in one pathological input', () => {
    expect(normalizePath('  a\\\\src\\\\deep//x.ts  ')).toBe('src/deep/x.ts');
  });

  it('is CASE-SENSITIVE — `SRC/Config.ts` is not `src/config.ts` (§4.1)', () => {
    // Folding case would make a wrong-file expectation silently PASS. Git is
    // case-sensitive and Linux CI is the reference platform.
    expect(normalizePath('SRC/Config.ts')).not.toBe(normalizePath('src/config.ts'));
    expect(normalizePath('SRC/Config.ts')).toBe('SRC/Config.ts');
    // …and the case-sensitivity is visible through the match rule itself.
    expect(matches(found('SRC/Config.ts', 10), exp({ file: 'src/config.ts', start_line: 10 }))).toBe(
      false,
    );
  });

  it('is idempotent — normalizing an already-normal path changes nothing', () => {
    for (const p of ['src/x.ts', 'a/', 'ab/x.ts', 'SRC/Config.ts', '']) {
      expect(normalizePath(normalizePath(p))).toBe(normalizePath(p));
    }
  });
});

// ===========================================================================
// §4.2 — interval semantics
// ===========================================================================

describe('§4.2 intervalsIntersect', () => {
  it('treats both intervals as CLOSED and inclusive', () => {
    expect(intervalsIntersect(1, 5, 5, 9)).toBe(true); // touch at 5
    expect(intervalsIntersect(1, 4, 5, 9)).toBe(false); // adjacent, no touch
    expect(intervalsIntersect(3, 4, 1, 10)).toBe(true); // fully contained
    expect(intervalsIntersect(1, 10, 3, 4)).toBe(true); // container on the left
    expect(intervalsIntersect(7, 7, 7, 7)).toBe(true); // single line, same
    expect(intervalsIntersect(7, 7, 8, 8)).toBe(false); // single line, adjacent
  });

  it('normalizes a REVERSED `start > end` on either or both sides', () => {
    expect(intervalsIntersect(9, 3, 5, 5)).toBe(true);
    expect(intervalsIntersect(5, 5, 9, 3)).toBe(true);
    expect(intervalsIntersect(9, 3, 4, 1)).toBe(true); // [3,9] vs [1,4]
    expect(intervalsIntersect(9, 3, 2, 1)).toBe(false); // [3,9] vs [1,2]
  });

  it('defaults a missing `end_line` to its own `start_line`', () => {
    expect(intervalsIntersect(7, null, 7, undefined)).toBe(true);
    expect(intervalsIntersect(7, undefined, 8, null)).toBe(false);
    expect(intervalsIntersect(7, null, 5, 9)).toBe(true); // point inside a range
    expect(intervalsIntersect(5, 9, 7, undefined)).toBe(true);
    expect(intervalsIntersect(4, null, 5, 9)).toBe(false); // point outside
    // A missing end on a REVERSED-looking single point is still a point.
    expect(intervalsIntersect(9, null, 3, 9)).toBe(true);
  });

  it('is symmetric for every pair in the matrix', () => {
    const pairs: ReadonlyArray<[number, number | null, number, number | null]> = [
      [1, 5, 5, 9],
      [1, 4, 5, 9],
      [9, 3, 5, 5],
      [7, null, 7, null],
      [7, null, 8, null],
      [3, 4, 1, 10],
    ];
    for (const [aS, aE, bS, bE] of pairs) {
      expect(intervalsIntersect(aS, aE, bS, bE)).toBe(intervalsIntersect(bS, bE, aS, aE));
    }
  });
});

// ===========================================================================
// §4.3 — the match rule
// ===========================================================================

describe('§4.3 matches — file + range ONLY', () => {
  it('matches on normalized file plus intersecting ranges', () => {
    expect(matches(found('src/x.ts', 10, 12), exp({ file: 'src/x.ts', start_line: 12 }))).toBe(true);
    expect(matches(found('b/src/x.ts', 10), exp({ file: 'src/x.ts', start_line: 10 }))).toBe(true);
    expect(matches(found('src/x.ts', 10), exp({ file: './src//x.ts', start_line: 10 }))).toBe(true);
  });

  it('IGNORES title, severity and category (advisory display metadata)', () => {
    const finding = found('src/x.ts', 10, 12);
    const bare = exp({ file: 'src/x.ts', start_line: 11 });
    const decorated = exp({
      file: 'src/x.ts',
      start_line: 11,
      title: 'Something else entirely',
      severity: 'CRITICAL',
      category: 'security',
    });
    const differentlyDecorated = exp({
      file: 'src/x.ts',
      start_line: 11,
      title: 'A third, unrelated wording',
      severity: 'SUGGESTION',
      category: 'style',
    });
    // All three behave identically: an improving agent may reword and
    // re-categorize; the harness scores detection, not prose.
    expect(matches(finding, bare)).toBe(true);
    expect(matches(finding, decorated)).toBe(true);
    expect(matches(finding, differentlyDecorated)).toBe(true);
  });

  it('rejects a different file and a non-intersecting range', () => {
    expect(matches(found('src/x.ts', 10), exp({ file: 'src/y.ts', start_line: 10 }))).toBe(false);
    expect(matches(found('src/x.ts', 10), exp({ file: 'src/x.ts', start_line: 40 }))).toBe(false);
    expect(
      matches(found('src/x.ts', 10, 20), exp({ file: 'src/x.ts', start_line: 21, end_line: 30 })),
    ).toBe(false);
  });

  it('honours a reversed expectation range and a missing `end_line`', () => {
    expect(
      matches(found('src/x.ts', 12), exp({ file: 'src/x.ts', start_line: 20, end_line: 5 })),
    ).toBe(true);
    expect(matches(found('src/x.ts', 12, 12), exp({ file: 'src/x.ts', start_line: 12 }))).toBe(true);
  });
});

// ===========================================================================
// §4.4 — per-case pass · §4.5 — the six counters
// ===========================================================================

describe('§4.4 scoreCase — per-case pass', () => {
  const twoLocations = expectedOutput('must_find', [
    exp({ file: 'src/a.ts', start_line: 10, end_line: 12 }),
    exp({ file: 'src/b.ts', start_line: 40 }),
  ]);

  it('must_find passes only when EVERY expectation is matched', () => {
    expect(
      scoreCase(
        twoLocations,
        outcome({ findings: [found('src/a.ts', 11), found('src/b.ts', 40)] }),
      ).pass,
    ).toBe(true);
    expect(scoreCase(twoLocations, outcome({ findings: [found('src/a.ts', 11)] })).pass).toBe(false);
    expect(scoreCase(twoLocations, outcome({ findings: [] })).pass).toBe(false);
  });

  it('one produced finding may satisfy two expectations at once', () => {
    const overlapping = expectedOutput('must_find', [
      exp({ file: 'src/a.ts', start_line: 10 }),
      exp({ file: 'src/a.ts', start_line: 11 }),
    ]);
    const scored = scoreCase(overlapping, outcome({ findings: [found('src/a.ts', 10, 11)] }));
    expect(scored.must_find_matched).toBe(2);
    expect(scored.pass).toBe(true);
  });

  it('must_not_flag passes only when NO produced finding matches', () => {
    const quiet = expectedOutput('must_not_flag', [
      exp({ file: 'src/clean.ts', start_line: 5, end_line: 9 }),
    ]);
    expect(scoreCase(quiet, outcome({ findings: [] })).pass).toBe(true);
    // A finding elsewhere in the diff is not noise — it is simply ignored.
    expect(scoreCase(quiet, outcome({ findings: [found('src/other.ts', 5)] })).pass).toBe(true);
    expect(scoreCase(quiet, outcome({ findings: [found('src/clean.ts', 7)] })).pass).toBe(false);
  });

  it('an ERRORED case is `pass = null`, never a fail — even when it would pass', () => {
    const quiet = expectedOutput('must_not_flag', [exp({ file: 'src/clean.ts', start_line: 5 })]);
    expect(scoreCase(quiet, outcome({ error: 'empty_diff' })).pass).toBeNull();
    expect(scoreCase(quiet, outcome({ error: 'provider_failed' })).pass).toBeNull();
    expect(scoreCase(quiet, outcome({ error: 'stale' })).pass).toBeNull();
    // A would-be FAIL also becomes null: an infrastructure failure is not an
    // agent regression (§4.4).
    expect(
      scoreCase(quiet, outcome({ findings: [found('src/clean.ts', 5)], error: 'timeout' })).pass,
    ).toBeNull();
  });

  it('treats an absent / empty `error` as "not errored"', () => {
    const quiet = expectedOutput('must_not_flag', [exp({ file: 'src/clean.ts', start_line: 5 })]);
    expect(scoreCase(quiet, outcome({ error: null })).pass).toBe(true);
    expect(scoreCase(quiet, outcome({ error: undefined })).pass).toBe(true);
    expect(scoreCase(quiet, outcome({ error: '' })).pass).toBe(true);
  });

  it('a must_find case with zero expectations is vacuously passing', () => {
    expect(scoreCase(expectedOutput('must_find', []), outcome()).pass).toBe(true);
  });
});

describe('§4.5 scoreCase — the six counters', () => {
  it('fills every counter for a must_find case', () => {
    const expected = expectedOutput('must_find', [
      exp({ file: 'src/a.ts', start_line: 10, end_line: 12 }),
      exp({ file: 'src/b.ts', start_line: 40 }),
    ]);
    const scored = scoreCase(
      expected,
      outcome({
        findings: [found('src/a.ts', 11), found('src/z.ts', 1), found('src/z.ts', 2)],
        droppedCount: 1,
      }),
    );
    expect(scored).toEqual({
      must_find_total: 2,
      must_find_matched: 1,
      must_not_flag_total: 0,
      noise_findings: 0, // a must_find case can never produce noise (§4.5)
      findings_total: 3,
      grounding_kept: 3,
      grounding_total: 4,
      pass: false,
    });
  });

  it('a finding matching TWO must_not_flag expectations counts ONCE', () => {
    // "We count wrong statements, not wrong pairs" (§4.5).
    const expected = expectedOutput('must_not_flag', [
      exp({ file: 'src/clean.ts', start_line: 5, end_line: 9 }),
      exp({ file: 'src/clean.ts', start_line: 8, end_line: 12 }),
    ]);
    const scored = scoreCase(expected, outcome({ findings: [found('src/clean.ts', 8, 9)] }));
    expect(scored.must_not_flag_total).toBe(2);
    expect(scored.noise_findings).toBe(1);
    expect(scored.findings_total).toBe(1);
    expect(scored.pass).toBe(false);
  });

  it('two findings hitting the SAME expectation count twice', () => {
    const expected = expectedOutput('must_not_flag', [
      exp({ file: 'src/clean.ts', start_line: 5, end_line: 9 }),
    ]);
    const scored = scoreCase(
      expected,
      outcome({ findings: [found('src/clean.ts', 5), found('src/clean.ts', 9)] }),
    );
    expect(scored.must_not_flag_total).toBe(1);
    expect(scored.noise_findings).toBe(2);
  });

  it('`grounding_total` is `kept + dropped` and `findings_total` is post-gate', () => {
    const scored = scoreCase(
      expectedOutput('must_not_flag', [exp({ file: 'src/clean.ts', start_line: 99 })]),
      outcome({ findings: [found('src/a.ts', 1), found('src/a.ts', 2)], droppedCount: 5 }),
    );
    expect(scored.grounding_kept).toBe(2);
    expect(scored.findings_total).toBe(2);
    expect(scored.grounding_total).toBe(7);
  });

  it('keeps the counters honest on an errored case (only the verdict is null)', () => {
    const scored = scoreCase(
      expectedOutput('must_find', [exp({ file: 'src/a.ts', start_line: 1 })]),
      outcome({ error: 'empty_diff' }),
    );
    expect(scored.must_find_total).toBe(1);
    expect(scored.must_find_matched).toBe(0);
    expect(scored.pass).toBeNull();
  });
});

// ===========================================================================
// §4.6 — micro-averaged metrics · §4.6.1 — batch counts
// ===========================================================================

describe('§4.6 aggregateBatch — micro-average over a hand-computed fixture', () => {
  //  A  must_find,  pass        mf 2/2 · findings 3 · kept 3 · total 4
  //  B  must_find,  fail        mf 1/3 · findings 2 · kept 2 · total 2
  //  C  must_not_flag, fail     mnf 1 · noise 1 · findings 5 · kept 5 · total 6
  //  D  errored (finished)      mf 0/4 — EXCLUDED from every sum
  //  E  pending (unfinished)    mf 7/7 — EXCLUDED from every sum
  const A = row({
    must_find_total: 2,
    must_find_matched: 2,
    findings_total: 3,
    grounding_kept: 3,
    grounding_total: 4,
    pass: true,
  });
  const B = row({
    must_find_total: 3,
    must_find_matched: 1,
    findings_total: 2,
    grounding_kept: 2,
    grounding_total: 2,
    pass: false,
  });
  const C = row({
    must_not_flag_total: 1,
    noise_findings: 1,
    findings_total: 5,
    grounding_kept: 5,
    grounding_total: 6,
    pass: false,
  });
  const D = row({
    must_find_total: 4,
    must_find_matched: 0,
    findings_total: 0,
    grounding_kept: 0,
    grounding_total: 0,
    pass: null,
    finished: true,
  });
  const E = row({
    must_find_total: 7,
    must_find_matched: 7,
    findings_total: 9,
    grounding_kept: 9,
    grounding_total: 9,
    pass: null,
    finished: false,
  });

  const agg = aggregateBatch([A, B, C, D, E]);

  it('sums the counters across the CONTRIBUTING rows only', () => {
    expect(agg.must_find_total).toBe(5); // 2 + 3
    expect(agg.must_find_matched).toBe(3); // 2 + 1
    expect(agg.must_not_flag_total).toBe(1);
    expect(agg.noise_findings).toBe(1);
    expect(agg.findings_total).toBe(10); // 3 + 2 + 5
    expect(agg.grounding_kept).toBe(10);
    expect(agg.grounding_total).toBe(12); // 4 + 2 + 6
  });

  it('micro-averages the three metrics (Σ numerator / Σ denominator)', () => {
    expect(agg.recall).toBeCloseTo(3 / 5, 12); // 0.6
    expect(agg.precision).toBeCloseTo(1 - 1 / 10, 12); // 0.9
    expect(agg.citation_accuracy).toBeCloseTo(10 / 12, 12); // 0.8333…
  });

  it('§4.6.1 counts every row, pending included, and errors separately', () => {
    expect(agg.cases_total).toBe(5); // rows in the batch, pending included
    expect(agg.cases_passed).toBe(1);
    expect(agg.cases_failed).toBe(2);
    expect(agg.cases_errored).toBe(1); // D only — E is pending, not errored
    // The remainder of `cases_total` is exactly the pending rows (here: E).
    expect(agg.cases_total - (agg.cases_passed + agg.cases_failed + agg.cases_errored)).toBe(1);
  });

  it('is micro, not macro: a rich case outweighs a trivial one', () => {
    const rich = row({ must_find_total: 4, must_find_matched: 4, pass: true });
    const trivial = row({ must_find_total: 1, must_find_matched: 0, pass: false });
    // Micro = 4/5 = 0.8. Macro (mean of per-case rates) would be 0.5.
    expect(aggregateBatch([rich, trivial]).recall).toBeCloseTo(0.8, 12);
  });
});

describe('AC-48 — errored and pending rows move NO metric', () => {
  const healthy = row({
    must_find_total: 2,
    must_find_matched: 2,
    findings_total: 4,
    grounding_kept: 4,
    grounding_total: 4,
    pass: true,
  });
  const errored = row({
    must_find_total: 6,
    must_find_matched: 0,
    findings_total: 0,
    grounding_kept: 0,
    grounding_total: 3,
    pass: null,
    finished: true,
  });
  const pending = row({
    must_find_total: 6,
    must_find_matched: 0,
    findings_total: 0,
    grounding_kept: 0,
    grounding_total: 3,
    pass: null,
    finished: false,
  });

  const baseline = aggregateBatch([healthy]);

  it('one provider failure never reads as a recall regression', () => {
    const withError = aggregateBatch([healthy, errored]);
    expect(withError.recall).toBe(baseline.recall);
    expect(withError.recall).toBe(1);
    // If the errored row kept its denominator, recall would be 2/8 = 0.25.
    expect(withError.recall).not.toBeCloseTo(0.25, 6);
  });

  it('an errored row contributes to NO numerator, NO denominator and NO sum', () => {
    const withError = aggregateBatch([healthy, errored]);
    expect(withError.must_find_total).toBe(baseline.must_find_total);
    expect(withError.must_find_matched).toBe(baseline.must_find_matched);
    expect(withError.findings_total).toBe(baseline.findings_total);
    expect(withError.grounding_kept).toBe(baseline.grounding_kept);
    expect(withError.grounding_total).toBe(baseline.grounding_total);
    expect(withError.precision).toBe(baseline.precision);
    expect(withError.citation_accuracy).toBe(baseline.citation_accuracy);
  });

  it('…but it IS counted in `cases_errored` and `cases_total`, so nothing is hidden', () => {
    const withError = aggregateBatch([healthy, errored]);
    expect(withError.cases_errored).toBe(1);
    expect(withError.cases_total).toBe(2);
    expect(withError.cases_passed).toBe(1);
    expect(withError.cases_failed).toBe(0);
  });

  it('a pending row is excluded too, and is NOT reported as errored (§8.1)', () => {
    const withPending = aggregateBatch([healthy, pending]);
    expect(withPending.recall).toBe(baseline.recall);
    expect(withPending.citation_accuracy).toBe(baseline.citation_accuracy);
    expect(withPending.cases_errored).toBe(0);
    expect(withPending.cases_total).toBe(2);
  });

  it('a batch of nothing but errored rows reports every metric as null', () => {
    const allErrored = aggregateBatch([errored, { ...errored }]);
    expect(allErrored.recall).toBeNull();
    expect(allErrored.precision).toBeNull();
    expect(allErrored.citation_accuracy).toBeNull();
    expect(allErrored.cases_errored).toBe(2);
  });
});

describe('§4.6 aggregateBatch — every zero-denominator branch returns null', () => {
  const cases: ReadonlyArray<{
    name: string;
    rows: readonly BatchScoreRow[];
    recall: 'null' | 'number';
    precision: 'null' | 'number';
    citation: 'null' | 'number';
  }> = [
    { name: 'an empty batch', rows: [], recall: 'null', precision: 'null', citation: 'null' },
    {
      name: 'only pending rows',
      rows: [row({ must_find_total: 2, findings_total: 2, grounding_total: 2, finished: false })],
      recall: 'null',
      precision: 'null',
      citation: 'null',
    },
    {
      name: 'only must_not_flag cases (recall has no denominator)',
      rows: [
        row({
          must_not_flag_total: 2,
          noise_findings: 1,
          findings_total: 4,
          grounding_kept: 4,
          grounding_total: 5,
          pass: false,
        }),
      ],
      recall: 'null',
      precision: 'number',
      citation: 'number',
    },
    {
      name: 'a silent agent (no findings ⇒ no precision, no citation denominator)',
      rows: [row({ must_find_total: 3, must_find_matched: 0, pass: false })],
      recall: 'number',
      precision: 'null',
      citation: 'null',
    },
    {
      name: 'a must_not_flag case the agent stayed silent on',
      rows: [row({ must_not_flag_total: 1, pass: true })],
      recall: 'null',
      precision: 'null',
      citation: 'null',
    },
  ];

  for (const c of cases) {
    it(`returns null where the denominator is zero — ${c.name}`, () => {
      const a = aggregateBatch(c.rows);
      for (const [metric, kind] of [
        [a.recall, c.recall],
        [a.precision, c.precision],
        [a.citation_accuracy, c.citation],
      ] as const) {
        if (kind === 'null') expect(metric).toBeNull();
        else expect(typeof metric).toBe('number');
      }
    });
  }

  it('NO metric is ever NaN, across the whole matrix', () => {
    const everyFixture: ReadonlyArray<readonly BatchScoreRow[]> = [
      ...cases.map((c) => c.rows),
      [row({ pass: null, finished: true })],
      [row({ must_find_total: 0, must_find_matched: 0, pass: true })],
      [row({ findings_total: 0, noise_findings: 0, pass: true })],
      [row({ grounding_kept: 0, grounding_total: 0, pass: true })],
    ];
    for (const rows of everyFixture) {
      const a = aggregateBatch(rows);
      for (const metric of [a.recall, a.precision, a.citation_accuracy]) {
        expect(Number.isNaN(metric as number)).toBe(false);
        expect(metric === null || Number.isFinite(metric)).toBe(true);
      }
    }
  });
});

describe('AC-41 — citation_accuracy is the engine’s own kept/dropped partition', () => {
  it('the gate dropping 1 of 4 findings yields citation_accuracy === 0.75', () => {
    const expected = expectedOutput('must_find', [exp({ file: 'src/a.ts', start_line: 10 })]);
    // 4 findings before the gate; 3 survive, 1 is dropped as ungroundable.
    const scored = scoreCase(
      expected,
      outcome({
        findings: [found('src/a.ts', 10), found('src/a.ts', 20), found('src/b.ts', 3)],
        droppedCount: 1,
      }),
    );
    expect(scored.grounding_kept).toBe(3);
    expect(scored.grounding_total).toBe(4);

    const agg = aggregateBatch([finished(scored)]);
    expect(agg.citation_accuracy).toBe(0.75);
  });

  it('a batch where nothing is dropped is a perfect 1.0', () => {
    const scored = scoreCase(
      expectedOutput('must_find', [exp({ file: 'src/a.ts', start_line: 10 })]),
      outcome({ findings: [found('src/a.ts', 10)], droppedCount: 0 }),
    );
    expect(aggregateBatch([finished(scored)]).citation_accuracy).toBe(1);
  });
});

// ===========================================================================
// §4.7 — canonical JSON + case fingerprint
// ===========================================================================

describe('§4.7 canonicalJson', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
    expect(canonicalJson({ z: { d: 1, c: 2 } })).toBe('{"z":{"c":2,"d":1}}');
  });

  it('PRESERVES array order — an expectation list is ordered data', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]');
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('handles `undefined` exactly as JSON.stringify does', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined])).toBe('[null]');
  });

  it('passes primitives through', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(7)).toBe('7');
    expect(canonicalJson('x')).toBe('"x"');
  });
});

describe('§4.7 caseFingerprint', () => {
  const diff = '@@ -1,2 +1,3 @@\n+const key = "sk_live_x";\n';
  // Raw literals, NOT zod-parsed: parsing would itself re-order the keys and
  // hide the very thing this block proves.
  const meta = { title: 'Add billing', body: 'why', number: 7 };
  const metaReordered = { number: 7, body: 'why', title: 'Add billing' };
  const expected = expectedOutput('must_find', [
    exp({ file: 'src/pay.ts', start_line: 2, title: 'Hardcoded key' }),
  ]);

  it('is deterministic and 16 lowercase hex characters', () => {
    const a = caseFingerprint(diff, meta, expected);
    expect(caseFingerprint(diff, meta, expected)).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is INSENSITIVE to `input_meta` key order (canonical JSON)', () => {
    expect(caseFingerprint(diff, metaReordered, expected)).toBe(
      caseFingerprint(diff, meta, expected),
    );
  });

  it('is insensitive to key order nested inside `expected_output`', () => {
    const reorderedExpectation = {
      expectations: [{ start_line: 2, title: 'Hardcoded key', file: 'src/pay.ts' }],
      kind: 'must_find',
    };
    expect(caseFingerprint(diff, meta, reorderedExpectation)).toBe(
      caseFingerprint(diff, meta, {
        kind: 'must_find',
        expectations: [{ file: 'src/pay.ts', start_line: 2, title: 'Hardcoded key' }],
      }),
    );
  });

  it('CHANGES when an expectation changes — this is what makes a batch incomparable', () => {
    const moved = expectedOutput('must_find', [
      exp({ file: 'src/pay.ts', start_line: 3, title: 'Hardcoded key' }),
    ]);
    expect(caseFingerprint(diff, meta, moved)).not.toBe(caseFingerprint(diff, meta, expected));

    const rekinded = expectedOutput('must_not_flag', [exp({ file: 'src/pay.ts', start_line: 2 })]);
    expect(caseFingerprint(diff, meta, rekinded)).not.toBe(caseFingerprint(diff, meta, expected));
  });

  it('changes when the pinned diff or the meta changes', () => {
    expect(caseFingerprint(`${diff}+more\n`, meta, expected)).not.toBe(
      caseFingerprint(diff, meta, expected),
    );
    expect(caseFingerprint(diff, { ...meta, title: 'Other' }, expected)).not.toBe(
      caseFingerprint(diff, meta, expected),
    );
  });
});

// ===========================================================================
// The module edge — parseExpectedOutput
// ===========================================================================

describe('parseExpectedOutput — safeParse at the edge, never a throw', () => {
  it('returns the parsed blob for valid input', () => {
    const parsed = parseExpectedOutput({
      kind: 'must_find',
      expectations: [{ file: 'src/a.ts', start_line: 1 }],
    });
    expect(parsed?.kind).toBe('must_find');
    expect(parsed?.expectations).toHaveLength(1);
  });

  it('returns null (never throws) for a hand-edited invalid blob', () => {
    for (const bad of [
      null,
      undefined,
      'not json',
      42,
      {},
      { kind: 'must_maybe', expectations: [] },
      { kind: 'must_find' },
      { kind: 'must_find', expectations: [{ file: '', start_line: 1 }] },
      { kind: 'must_find', expectations: [{ file: 'a.ts' }] },
      { kind: 'must_find', expectations: [{ file: 'a.ts', start_line: 1.5 }] },
    ]) {
      expect(parseExpectedOutput(bad)).toBeNull();
    }
  });
});

// ===========================================================================
// §8.4 — the alert rules
// ===========================================================================

describe('§8.4 deltaPoints — half AWAY from zero', () => {
  it('converts a fractional metric delta into whole points', () => {
    expect(deltaPoints(0.82, 0.78)).toBe(4);
    expect(deltaPoints(0.78, 0.82)).toBe(-4);
    expect(deltaPoints(0.8, 0.7)).toBe(10); // 0.10000000000000009 × 100
    expect(deltaPoints(0.5, 0.5)).toBe(0);
  });

  it('rounds exactly +2.5 to 3 AND exactly −2.5 to −3', () => {
    // The trap: JS `Math.round(-2.5)` is −2, so a −2.5 pt precision drop would
    // read as a non-significant −2 while its mirror image reads as +3. The
    // threshold would be asymmetric on the regression side.
    expect(deltaPoints(0.8, 0.775)).toBe(3);
    expect(deltaPoints(0.775, 0.8)).toBe(-3);
    expect(Math.round(-2.5)).toBe(-2); // the behaviour being defended against
  });

  it('is antisymmetric across the boundary', () => {
    for (const [h, b] of [
      [0.8, 0.775],
      [0.82, 0.78],
      [1, 0.975],
      [0.5, 0.475],
    ] as const) {
      expect(deltaPoints(h, b)).toBe(-deltaPoints(b, h));
    }
  });

  it('rounds a sub-point move to zero magnitude', () => {
    // `Math.sign(-0.1) * Math.round(0.1)` is `-0`; only the MAGNITUDE matters —
    // rule 3 filters it out before it can ever become an `EvalAlertSignal`.
    expect(Math.abs(deltaPoints(0.5, 0.501))).toBe(0);
    expect(Math.abs(deltaPoints(0.501, 0.5))).toBe(0);
  });
});

describe('§8.4 buildAlert', () => {
  it('rule 1 — fewer than two complete batches means no banner', () => {
    expect(buildAlert(batch(), null)).toBeNull();
    expect(buildAlert(null, batch())).toBeNull();
    expect(buildAlert(undefined, undefined)).toBeNull();
  });

  it('rules 3+4 — a sub-threshold move is noise, not news', () => {
    const alert = buildAlert(
      batch({ recall: 0.81, precision: 0.81, citation_accuracy: 0.81 }),
      batch({ recall: 0.8, precision: 0.8, citation_accuracy: 0.8 }),
    );
    expect(alert).toBeNull();
  });

  it('rule 3 — exactly ALERT_THRESHOLD_PTS is significant', () => {
    const step = ALERT_THRESHOLD_PTS / 100;
    const alert = buildAlert(
      batch({ recall: 0.8 + step, precision: null, citation_accuracy: null }),
      batch({ recall: 0.8, precision: null, citation_accuracy: null }),
    );
    expect(alert?.primary).toEqual({
      metric: 'recall',
      direction: 'up',
      delta_pts: ALERT_THRESHOLD_PTS,
    });
  });

  it('rule 2 — a metric that is null on EITHER side is skipped entirely', () => {
    // Precision moved a mile, but the head batch had a zero denominator.
    const alert = buildAlert(
      batch({ recall: 0.81, precision: null, citation_accuracy: 0.81 }),
      batch({ recall: 0.8, precision: 0.2, citation_accuracy: 0.8 }),
    );
    expect(alert).toBeNull();

    const nullOnBase = buildAlert(
      batch({ recall: 0.8, precision: 0.9 }),
      batch({ recall: 0.8, precision: null }),
    );
    expect(nullOnBase).toBeNull();

    // …and the surviving metrics are still reported.
    const partial = buildAlert(
      batch({ recall: 0.9, precision: null }),
      batch({ recall: 0.8, precision: null }),
    );
    expect(partial?.primary.metric).toBe('recall');
    expect(partial?.others).toEqual([]);
  });

  it('rule 5 — the largest absolute mover wins, regardless of priority', () => {
    const alert = buildAlert(
      batch({ recall: 0.75, precision: 0.82 }),
      batch({ recall: 0.8, precision: 0.8 }),
    );
    expect(alert?.primary).toEqual({ metric: 'recall', direction: 'down', delta_pts: -5 });
    expect(alert?.tone).toBe('warn');
  });

  it('rule 5 — ties break precision > recall > citation_accuracy', () => {
    expect(ALERT_METRIC_PRIORITY).toEqual(['precision', 'recall', 'citation_accuracy']);

    // precision vs recall, both −3 → precision.
    expect(
      buildAlert(batch({ recall: 0.77, precision: 0.77 }), batch({ recall: 0.8, precision: 0.8 }))
        ?.primary.metric,
    ).toBe('precision');

    // recall vs citation, both +4, precision unmoved → recall.
    expect(
      buildAlert(
        batch({ recall: 0.84, citation_accuracy: 0.84 }),
        batch({ recall: 0.8, citation_accuracy: 0.8 }),
      )?.primary.metric,
    ).toBe('recall');

    // all three tied at +3 → precision, and `others` keeps the same order.
    const threeWay = buildAlert(
      batch({ recall: 0.83, precision: 0.83, citation_accuracy: 0.83 }),
      batch({ recall: 0.8, precision: 0.8, citation_accuracy: 0.8 }),
    );
    expect(threeWay?.primary.metric).toBe('precision');
    expect(threeWay?.others.map((s) => s.metric)).toEqual(['recall', 'citation_accuracy']);
  });

  it('rule 7 — `others` is the rest, in priority order (not magnitude order)', () => {
    const alert = buildAlert(
      batch({ precision: 0.83, recall: 0.84, citation_accuracy: 0.85 }),
      batch({ precision: 0.8, recall: 0.8, citation_accuracy: 0.8 }),
    );
    expect(alert?.primary.metric).toBe('citation_accuracy'); // +5, the largest
    expect(alert?.others.map((s) => s.metric)).toEqual(['precision', 'recall']);
    expect(alert?.others.map((s) => s.delta_pts)).toEqual([3, 4]);
  });

  it('rule 6 — tone follows the PRIMARY direction only', () => {
    expect(buildAlert(batch({ recall: 0.9 }), batch({ recall: 0.8 }))?.tone).toBe('info');
    expect(buildAlert(batch({ recall: 0.7 }), batch({ recall: 0.8 }))?.tone).toBe('warn');
    // Primary up, another metric down → still `info`.
    const mixed = buildAlert(
      batch({ recall: 0.9, precision: 0.77 }),
      batch({ recall: 0.8, precision: 0.8 }),
    );
    expect(mixed?.primary.metric).toBe('recall');
    expect(mixed?.tone).toBe('info');
  });

  it('rule 8 — `new_false_positive` needs a precision DROP *and* a noise rise', () => {
    const drop = { precision: 0.75, recall: 0.8, citation_accuracy: 0.8 };
    const base = batch({ precision: 0.8, noise_findings: 3 });

    expect(buildAlert(batch({ ...drop, noise_findings: 5 }), base)?.new_false_positive).toBe(true);
    // Same precision drop, noise unchanged → the clause is omitted.
    expect(buildAlert(batch({ ...drop, noise_findings: 3 }), base)?.new_false_positive).toBe(false);
    // Noise actually fell (the agent just said less overall) → omitted.
    expect(buildAlert(batch({ ...drop, noise_findings: 1 }), base)?.new_false_positive).toBe(false);
  });

  it('rule 8 — a precision RISE, or a non-precision primary, is never a new FP', () => {
    // Precision up with noise up.
    expect(
      buildAlert(
        batch({ precision: 0.9, noise_findings: 9 }),
        batch({ precision: 0.8, noise_findings: 3 }),
      )?.new_false_positive,
    ).toBe(false);
    // Recall is the primary; precision fell only 1pt (sub-threshold).
    const recallPrimary = buildAlert(
      batch({ recall: 0.7, precision: 0.79, noise_findings: 9 }),
      batch({ recall: 0.8, precision: 0.8, noise_findings: 3 }),
    );
    expect(recallPrimary?.primary.metric).toBe('recall');
    expect(recallPrimary?.new_false_positive).toBe(false);
  });

  it('carries the head agent version, or null when the row predates 0018', () => {
    expect(
      buildAlert(batch({ recall: 0.9, agent_version: 7 }), batch({ recall: 0.8 }))?.head_version,
    ).toBe(7);
    expect(buildAlert(batch({ recall: 0.9 }), batch({ recall: 0.8 }))?.head_version).toBeNull();
  });

  it('always emits a valid C16 `EvalAlertDetail`', () => {
    const alert = buildAlert(
      batch({ recall: 0.9, precision: 0.75, citation_accuracy: 0.84, agent_version: 7 }),
      batch({ recall: 0.8, precision: 0.8, citation_accuracy: 0.8, noise_findings: 1 }),
    );
    expect(() => EvalAlertDetail.parse(alert)).not.toThrow();
  });
});

describe('§8.4 alertFallbackSentence — the frozen-contract filler', () => {
  it('reproduces the design’s reference banner exactly', () => {
    // primary = precision −2 (tie, priority), others = recall +2, citation +2,
    // noise rose ⇒ the "new false positive" clause is licensed.
    const alert = buildAlert(
      batch({
        precision: 0.78,
        recall: 0.82,
        citation_accuracy: 0.82,
        noise_findings: 4,
        agent_version: 7,
      }),
      batch({ precision: 0.8, recall: 0.8, citation_accuracy: 0.8, noise_findings: 1 }),
    );
    expect(alert?.primary).toEqual({ metric: 'precision', direction: 'down', delta_pts: -2 });
    expect(alert?.new_false_positive).toBe(true);
    expect(alertFallbackSentence(alert!)).toBe(
      'Precision dipped 2pts on v7 — a new false positive slipped in. Recall and citation both up.',
    );
  });

  it('omits the version, the clause and the tail when they do not apply', () => {
    const alert = buildAlert(batch({ recall: 0.85 }), batch({ recall: 0.8 }));
    expect(alertFallbackSentence(alert!)).toBe('Recall rose 5pts.');
  });

  it('spells out mixed directions rather than picking a misleading verb', () => {
    const alert = buildAlert(
      batch({ precision: 0.7, recall: 0.85, citation_accuracy: 0.75 }),
      batch({ precision: 0.8, recall: 0.8, citation_accuracy: 0.8 }),
    );
    expect(alert?.primary.metric).toBe('precision');
    expect(alertFallbackSentence(alert!)).toBe('Precision dipped 10pts. Recall up, citation down.');
  });

  it('uses the singular unit for a 1-point move', () => {
    // Not reachable while ALERT_THRESHOLD_PTS is 2, but the function is
    // exported and the constant is explicitly re-tunable (constants.ts Q2).
    const detail = EvalAlertDetail.parse({
      tone: 'warn',
      primary: { metric: 'recall', direction: 'down', delta_pts: -1 },
      others: [],
      new_false_positive: false,
      head_version: null,
    });
    expect(alertFallbackSentence(detail)).toBe('Recall dipped 1pt.');
  });
});

// ===========================================================================
// §7 / AC-8 — case naming
// ===========================================================================

describe('§7 slugifyCaseName', () => {
  it('reproduces the design’s own case names from real finding titles', () => {
    expect(slugifyCaseName('Stripe key leak')).toBe('stripe-key-leak');
    expect(slugifyCaseName('SSRF via webhook URL')).toBe('ssrf-via-webhook-url');
    expect(slugifyCaseName('Missing Retry-After header')).toBe('missing-retry-after-header');
    expect(slugifyCaseName('Service role key used in client')).toBe(
      'service-role-key-used-in-client',
    );
  });

  it('collapses every run of non-alphanumerics into one `-` and trims the ends', () => {
    expect(slugifyCaseName('  --Hello,   World!!  ')).toBe('hello-world');
    expect(slugifyCaseName('API_KEY leaked in v2.1')).toBe('api-key-leaked-in-v2-1');
    expect(slugifyCaseName('a___b---c...d')).toBe('a-b-c-d');
  });

  it(`falls back to "${FALLBACK_CASE_SLUG}" when nothing sluggable survives`, () => {
    for (const title of ['', '   ', '!!!', '---', '🚀🚀', '（）']) {
      expect(slugifyCaseName(title)).toBe(FALLBACK_CASE_SLUG);
    }
  });

  it(`caps the slug at MAX_CASE_SLUG_LENGTH (${MAX_CASE_SLUG_LENGTH})`, () => {
    const long = slugifyCaseName('x'.repeat(120));
    expect(long).toBe('x'.repeat(MAX_CASE_SLUG_LENGTH));
    expect(long.length).toBe(MAX_CASE_SLUG_LENGTH);
  });

  it('never leaves a trailing `-` after the cap, so it cannot compose into `foo--2`', () => {
    // The cap lands exactly on a separator: `a`×47 + `-b` is 49 chars, so
    // slicing to 48 would end in `-`.
    const title = `${'a'.repeat(MAX_CASE_SLUG_LENGTH - 1)} b`;
    const slug = slugifyCaseName(title);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug).toBe('a'.repeat(MAX_CASE_SLUG_LENGTH - 1));
    // The behaviour that matters: the collision suffix reads cleanly.
    expect(nextFreeName(slug, [slug])).toBe(`${'a'.repeat(MAX_CASE_SLUG_LENGTH - 1)}-2`);
    expect(nextFreeName(slug, [slug])).not.toContain('--');
  });

  it('emits nothing but `[a-z0-9-]`, for every title in the matrix', () => {
    const titles = [
      'Stripe key leak',
      '  --Hello,   World!!  ',
      'API_KEY leaked in v2.1',
      '🚀 Ship it',
      'Ünïcödé tïtlé',
      'x'.repeat(120),
      '',
    ];
    for (const t of titles) {
      expect(slugifyCaseName(t)).toMatch(/^[a-z0-9-]+$/);
      expect(slugifyCaseName(t).length).toBeLessThanOrEqual(MAX_CASE_SLUG_LENGTH);
    }
  });
});

describe('§7 nextFreeName — the collision table', () => {
  const S = 'stripe-key-leak';
  const table: ReadonlyArray<[readonly string[], string]> = [
    [[], S],
    [['other'], S],
    [[S], `${S}-2`],
    [[S, `${S}-2`], `${S}-3`],
    [[S, `${S}-2`, `${S}-3`], `${S}-4`],
    // Gaps are filled: `-2` is free even though `-3` is taken.
    [[S, `${S}-3`], `${S}-2`],
    // The unsuffixed slug is free, so no suffix is invented.
    [[`${S}-2`, `${S}-3`], S],
  ];

  for (const [taken, want] of table) {
    it(`taken=[${taken.join(', ')}] → ${want}`, () => {
      expect(nextFreeName(S, taken)).toBe(want);
    });
  }

  it('compares exact strings — a differently-cased name is not a collision', () => {
    expect(nextFreeName(S, ['Stripe-Key-Leak', 'STRIPE-KEY-LEAK'])).toBe(S);
  });

  it('lets the suffix push past the cap rather than re-colliding', () => {
    const capped = 'x'.repeat(MAX_CASE_SLUG_LENGTH);
    const next = nextFreeName(capped, [capped]);
    expect(next).toBe(`${capped}-2`);
    expect(next.length).toBeGreaterThan(MAX_CASE_SLUG_LENGTH);
  });
});

// ===========================================================================
// §9.1 — the system-prompt diff
// ===========================================================================

describe('§9.1 promptDiff — line kinds', () => {
  const kinds = (lines: readonly { kind: string }[]) => lines.map((l) => l.kind);
  const texts = (lines: readonly { text: string }[]) => lines.map((l) => l.text);

  it('emits only C18-valid lines', () => {
    const out = promptDiff('a\nold\nb', 'a\nnew\nb');
    expect(() => z.array(EvalPromptDiffLine).parse(out)).not.toThrow();
  });

  it('reports two identical prompts as pure context', () => {
    const out = promptDiff('one\ntwo\nthree', 'one\ntwo\nthree');
    expect(kinds(out)).toEqual(['context', 'context', 'context']);
    expect(texts(out)).toEqual(['one', 'two', 'three']);
  });

  it('reports a pure insertion, a pure deletion and a replacement', () => {
    expect(kinds(promptDiff('a\nb', 'a\nx\nb'))).toEqual(['context', 'added', 'context']);
    expect(kinds(promptDiff('a\nx\nb', 'a\nb'))).toEqual(['context', 'removed', 'context']);
    // Removed BEFORE added, matching unified diff, so the client renders
    // `−` above `+` without re-sorting.
    expect(kinds(promptDiff('a\nold\nb', 'a\nnew\nb'))).toEqual([
      'context',
      'removed',
      'added',
      'context',
    ]);
    expect(texts(promptDiff('a\nold\nb', 'a\nnew\nb'))).toEqual(['a', 'old', 'new', 'b']);
  });

  it('handles empty prompts on either side', () => {
    expect(promptDiff('', '')).toEqual([]);
    expect(promptDiff('', 'a\nb')).toEqual([
      { kind: 'added', text: 'a' },
      { kind: 'added', text: 'b' },
    ]);
    expect(promptDiff('a\nb', '')).toEqual([
      { kind: 'removed', text: 'a' },
      { kind: 'removed', text: 'b' },
    ]);
  });

  it('tolerates CRLF, so a line ending never renders as a change', () => {
    expect(kinds(promptDiff('a\r\nb\r\nc', 'a\nb\nc'))).toEqual(['context', 'context', 'context']);
  });

  it('does report a changed trailing newline (it IS a change to the prompt)', () => {
    expect(kinds(promptDiff('a', 'a\n'))).toEqual(['context', 'added']);
  });

  it('is deterministic — the same pair always yields the same lines', () => {
    const a = 'alpha\nbeta\ngamma\ndelta';
    const b = 'alpha\nBETA\ngamma\nepsilon\ndelta';
    expect(promptDiff(a, b)).toEqual(promptDiff(a, b));
  });

  it('keeps the changes, not the prose, when the full alignment exceeds the cap', () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i}`);
    const changed = [...lines];
    changed[300] = 'line 300 — rewritten';
    const out = promptDiff(lines.join('\n'), changed.join('\n'));

    expect(out.length).toBeLessThanOrEqual(MAX_PROMPT_DIFF_LINES);
    // One removed + one added, plus PROMPT_DIFF_CONTEXT_LINES either side.
    expect(out.length).toBe(2 + 2 * PROMPT_DIFF_CONTEXT_LINES);
    expect(kinds(out).filter((k) => k === 'removed')).toHaveLength(1);
    expect(kinds(out).filter((k) => k === 'added')).toHaveLength(1);
    expect(texts(out)).toContain('line 300');
    expect(texts(out)).toContain('line 300 — rewritten');
  });

  it('never exceeds MAX_PROMPT_DIFF_LINES, even on a wholesale rewrite', () => {
    const base = Array.from({ length: 1200 }, (_, i) => `old ${i}`).join('\n');
    const head = Array.from({ length: 1200 }, (_, i) => `new ${i}`).join('\n');
    const out = promptDiff(base, head);
    expect(out.length).toBeLessThanOrEqual(MAX_PROMPT_DIFF_LINES);
    expect(new Set(kinds(out))).toEqual(new Set(['removed', 'added']));
  });

  it('collapses two identical over-cap prompts to nothing (there is no change to keep)', () => {
    // Documented consequence of the cap: above MAX_PROMPT_DIFF_LINES the
    // context-compression pass keeps only lines near a change, and an
    // unchanged prompt has none. The compare modal renders "no differences".
    const big = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n');
    expect(promptDiff(big, big)).toEqual([]);
  });
});

// ===========================================================================
// §14 — scoring cost, asserted as an UPPER BOUND (not a benchmark)
// ===========================================================================

describe('§14 scoring cost', () => {
  it('scores + aggregates a worst-case 50-case batch in under 20 ms', () => {
    const SIZE = 50; // §14: F, E ≤ 50
    const cases = Array.from({ length: SIZE }, () => ({
      expected: expectedOutput(
        'must_find',
        Array.from({ length: SIZE }, (_, i) =>
          exp({ file: `src/mod-${i % 7}/file-${i}.ts`, start_line: i * 3 + 1, end_line: i * 3 + 2 }),
        ),
      ),
      outcome: outcome({
        findings: Array.from({ length: SIZE }, (_, i) =>
          found(`src/mod-${i % 7}/file-${i}.ts`, i * 3 + 1, i * 3 + 2),
        ),
        droppedCount: 1,
      }),
    }));

    const runOnce = (): number => {
      const t0 = performance.now();
      aggregateBatch(cases.map((c) => finished(scoreCase(c.expected, c.outcome))));
      return performance.now() - t0;
    };

    runOnce(); // warm-up: exclude first-call JIT from an upper bound
    // Best of three: an upper bound must not be defeated by a GC pause or the
    // scheduler on a loaded CI box. Measured locally at ~7 ms.
    const elapsed = Math.min(runOnce(), runOnce(), runOnce());
    expect(elapsed).toBeLessThan(20);
  });
});
