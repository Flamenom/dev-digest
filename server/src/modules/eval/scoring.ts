/**
 * L06 Eval Pipeline — scoring. THE WHOLE OF SPEC §4, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * PURE. Plain data in, counters out.
 * ---------------------------------------------------------------------------
 * ZERO LLM calls, zero I/O, zero framework. The only imports are the shared
 * Zod contracts and `node:crypto` (sha256 for the fingerprint, §4.7) — a pure
 * hash, not I/O. This is mechanically enforced by the `eval-scoring-purity`
 * rule in `.dependency-cruiser.cjs` (`pnpm arch`), which is `error`-severity:
 * nothing here may reach `db/`, `adapters/`, `fastify` or the composition root.
 * Onion §2: "pure functions are not infrastructure" — this file is a decision
 * rule, so it sits inward even though it lives inside a feature slice.
 *
 * Complexity is `O(F × E)` (produced findings × expectations) per case.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANT THAT TRAVELS WITH THIS CODE
 * ---------------------------------------------------------------------------
 * `grounding_total = grounding_kept + droppedCount` is the true PRE-GATE
 * finding count ONLY because the eval runner never passes `intent` to
 * `reviewPullRequest`. `groundFindings` partitions the merged findings into
 * `kept ∪ dropped`, but with an `intent` present the scope filter drops further
 * findings AFTER grounding (`reviewer-core/src/review/run.ts`), and the
 * partition — and therefore `citation_accuracy` — silently stops meaning what
 * it claims. If the runner ever needs `intent`, the purity-preserving fix is an
 * additive `preGateCount: number` on `ReviewOutcome`, not a fudge here (§4.5).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 *  - The engine side is NOT normalized (§4.1). `parseUnifiedDiff` already
 *    strips `b/` and `groundFindings` compares exact strings; normalization is
 *    a DEFENSIVE layer on the hand-editable EXPECTATION side only. Normalizing
 *    both sides here would paper over a genuine mismatch between what the model
 *    said and what the diff contains.
 *  - `title` / `severity` / `category` take NO part in the match rule (§4.3).
 *    They are advisory display metadata. Requiring a title match would score
 *    prose instead of detection and would punish an agent for rewording.
 */

import { createHash } from 'node:crypto';
import { EvalExpectedOutput } from '@devdigest/shared';
import type { EvalExpectation } from '@devdigest/shared';

// ===========================================================================
// Plain-data inputs — structural, so nothing outward has to be imported
// ===========================================================================

/**
 * The only part of a produced `Finding` the match rule reads (§4.3). Declared
 * structurally so this module never imports the engine or a DB row type; a
 * real `Finding` from `@devdigest/shared` satisfies it.
 */
export interface MatchableFinding {
  file: string;
  start_line: number;
  end_line: number;
}

/**
 * The only part of a `ReviewOutcome` scoring reads, flattened to plain data:
 *
 *   findings     = outcome.review.findings   (POST-gate — what the agent said)
 *   droppedCount = outcome.dropped.length    (grounding-gate casualties)
 *
 * `error` is set when the case could not be executed at all (empty diff,
 * provider failure, timeout, stale). An errored case scores `pass = null` — an
 * infrastructure failure is NEVER an agent regression (§4.4).
 */
export interface CaseOutcome {
  findings: readonly MatchableFinding[];
  droppedCount: number;
  error?: string | null;
}

// ===========================================================================
// §4.1 — path normalization
// ===========================================================================

/**
 * The exact six-step §4.1 pipeline, in order:
 *   1. `\` → `/` (pasted Windows paths)
 *   2. trim surrounding whitespace
 *   3. strip ONE leading `a/` or `b/`, only if the remainder is non-empty
 *   4. strip a leading `./`, repeatedly
 *   5. collapse runs of `/` into one
 *   6. strip a leading `/`
 *
 * CASE-SENSITIVE, on purpose. Git is case-sensitive and Linux CI is the
 * reference platform; folding case would make `SRC/Config.ts` match
 * `src/config.ts` and silently PASS a wrong-file expectation. The accepted cost
 * — a hand-typed path on a case-insensitive macOS checkout failing to match —
 * is surfaced as a case-editor warning (AC-13), never swallowed.
 */
export function normalizePath(p: string): string {
  // 1 — Windows separators
  let out = p.replace(/\\/g, '/');
  // 2 — surrounding whitespace
  out = out.trim();
  // 3 — one git diff prefix, only when something survives it
  if ((out.startsWith('a/') || out.startsWith('b/')) && out.length > 2) {
    out = out.slice(2);
  }
  // 4 — leading `./`, repeatedly
  while (out.startsWith('./')) out = out.slice(2);
  // 5 — collapse duplicate separators
  out = out.replace(/\/{2,}/g, '/');
  // 6 — leading separator
  if (out.startsWith('/')) out = out.slice(1);
  return out;
}

// ===========================================================================
// §4.2 — interval semantics
// ===========================================================================

/**
 * Closed, INCLUSIVE intervals of new-side line numbers — the same space the
 * grounding gate indexes. Each side is normalized `lo = min(start, end)`,
 * `hi = max(start, end)` (mirroring `rangeIntersects`, `grounding.ts`), so a
 * hand-written reversed range still behaves. A missing / null `end` defaults to
 * its own `start`.
 *
 * Two intervals intersect iff `aLo <= bHi && bLo <= aHi`.
 */
export function intervalsIntersect(
  aStart: number,
  aEnd: number | null | undefined,
  bStart: number,
  bEnd: number | null | undefined,
): boolean {
  const a2 = aEnd ?? aStart;
  const b2 = bEnd ?? bStart;
  const aLo = Math.min(aStart, a2);
  const aHi = Math.max(aStart, a2);
  const bLo = Math.min(bStart, b2);
  const bHi = Math.max(bStart, b2);
  return aLo <= bHi && bLo <= aHi;
}

// ===========================================================================
// §4.3 — the match rule
// ===========================================================================

/**
 * `matches := same normalized file AND intersecting line ranges`. FILE + RANGE
 * ONLY — see the file header for why `title` / `severity` / `category` are
 * excluded (§4.3). The expectation side is normalized (§4.1); the finding side
 * is normalized too so that a model echoing `b/src/x.ts` is not judged on
 * a prefix, but note the engine has already stripped it.
 */
export function matches(finding: MatchableFinding, expectation: EvalExpectation): boolean {
  if (normalizePath(finding.file) !== normalizePath(expectation.file)) return false;
  return intervalsIntersect(
    finding.start_line,
    finding.end_line,
    expectation.start_line,
    expectation.end_line,
  );
}

// ===========================================================================
// §4.5 — per-case counters, §4.4 — per-case pass
// ===========================================================================

/** The §4.5 primitives everything else sums. */
export interface CaseCounters {
  /** `expectations.length` when the case is `must_find`, else 0. */
  must_find_total: number;
  /** `must_find` expectations matched by ≥1 produced finding. */
  must_find_matched: number;
  /** `expectations.length` when the case is `must_not_flag`, else 0. */
  must_not_flag_total: number;
  /**
   * Produced findings matching ≥1 `must_not_flag` expectation. A finding
   * matching TWO expectations counts ONCE — we count wrong statements, not
   * wrong pairs (§4.5).
   */
  noise_findings: number;
  /** Produced (post-gate) findings — what the agent actually said. */
  findings_total: number;
  /** `outcome.review.findings.length`. */
  grounding_kept: number;
  /** `grounding_kept + dropped.length` — the pre-gate count; see file header. */
  grounding_total: number;
}

/** A scored case: the §4.5 counters plus the §4.4 verdict. */
export interface ScoredCase extends CaseCounters {
  /**
   * `true` / `false` per §4.4; `null` when the case errored or has not run.
   * An infrastructure failure must never be counted as a fail.
   */
  pass: boolean | null;
}

const ZERO_COUNTERS: CaseCounters = {
  must_find_total: 0,
  must_find_matched: 0,
  must_not_flag_total: 0,
  noise_findings: 0,
  findings_total: 0,
  grounding_kept: 0,
  grounding_total: 0,
};

function assertNever(x: never): never {
  throw new Error(`unreachable expectation kind: ${JSON.stringify(x)}`);
}

/**
 * Score one case against one engine outcome. Pure: same inputs, same output.
 *
 * `expected` arrives ALREADY PARSED — `parseExpectedOutput` is the module edge
 * where the untyped jsonb blob is validated, so no Zod work happens inside a
 * scoring loop.
 */
export function scoreCase(expected: EvalExpectedOutput, outcome: CaseOutcome): ScoredCase {
  const findings = outcome.findings;
  const expectations = expected.expectations;

  const groundingKept = findings.length;
  const counters: CaseCounters = {
    ...ZERO_COUNTERS,
    findings_total: groundingKept,
    grounding_kept: groundingKept,
    grounding_total: groundingKept + outcome.droppedCount,
  };

  switch (expected.kind) {
    case 'must_find': {
      counters.must_find_total = expectations.length;
      for (const expectation of expectations) {
        if (findings.some((f) => matches(f, expectation))) counters.must_find_matched += 1;
      }
      break;
    }
    case 'must_not_flag': {
      counters.must_not_flag_total = expectations.length;
      for (const finding of findings) {
        // `.some` — one finding matching two expectations is ONE noise finding.
        if (expectations.some((e) => matches(finding, e))) counters.noise_findings += 1;
      }
      break;
    }
    default:
      return assertNever(expected.kind);
  }

  // §4.4. Errored short-circuits: the counters above stay honest (they are a
  // property of the case), but the verdict is `null`, and `aggregateBatch`
  // keeps errored rows out of every numerator and denominator.
  if (outcome.error != null && outcome.error !== '') {
    return { ...counters, pass: null };
  }

  const pass =
    expected.kind === 'must_find'
      ? counters.must_find_matched === counters.must_find_total
      : counters.noise_findings === 0;

  return { ...counters, pass };
}

// ===========================================================================
// §4.6 — micro-averaged metrics, §4.6.1 — batch counts
// ===========================================================================

/** One row of a batch: a scored case plus whether it has finished executing. */
export interface BatchScoreRow extends ScoredCase {
  /**
   * `false` while the pending `eval_runs` row still has `actual_output IS NULL`
   * (§5.3). Pending rows count towards `cases_total` and nothing else.
   */
  finished: boolean;
}

/** The aggregate of one batch: three metrics, the §4.6.1 counts, the sums. */
export interface BatchAggregate extends CaseCounters {
  /** `Σ must_find_matched / Σ must_find_total` — `null` on a zero denominator. */
  recall: number | null;
  /** `1 − (Σ noise_findings / Σ findings_total)` — `null` on a zero denominator. */
  precision: number | null;
  /** `Σ grounding_kept / Σ grounding_total` — `null` on a zero denominator. */
  citation_accuracy: number | null;
  /** Rows in the batch, pending included (§4.6.1). */
  cases_total: number;
  cases_passed: number;
  cases_failed: number;
  /** `pass === null` AND the row has finished — pending rows are not errored. */
  cases_errored: number;
}

/**
 * Micro-average a batch (§4.6) and count its cases (§4.6.1).
 *
 * MICRO, not macro: numerators and denominators are summed across cases, so a
 * case with 3 expectations weighs 3× a case with 1 — the right weighting for a
 * set grown organically from real findings of uneven size. Macro would let a
 * trivial single-expectation case swing the number as hard as a rich one, and
 * is undefined for every zero-denominator case. Micro has exactly ONE undefined
 * case (the whole denominator being zero), handled explicitly below.
 *
 * WHICH ROWS FEED THE METRICS — the load-bearing decision in this file, since a
 * wrong denominator invalidates every number the product reports:
 *
 *  - PENDING rows (`finished === false`) contribute nothing. A running batch
 *    reports partial counts and the UI shows a spinner in place of numbers
 *    (§8.1, AC-22).
 *  - ERRORED rows (`finished && pass === null`) contribute nothing EITHER, to
 *    any numerator or any denominator. §4.4 makes an infrastructure failure not
 *    an agent regression; letting an errored `must_find` case keep its
 *    `must_find_total` in the recall denominator would silently reintroduce
 *    exactly that, and one provider hiccup would read as a recall drop
 *    (AC-48). They are still counted in `cases_errored`, so nothing is hidden.
 *
 * NO METRIC CAN EVER BE `NaN`: each of the three divisions below has its own
 * explicit zero-denominator branch returning `null` (§4.6). Do not collapse
 * them into a shared helper that could be called with an unguarded denominator.
 *
 * A PER-CASE row's own metrics (`eval_runs.recall/precision/citation_accuracy`)
 * are the same formulas restricted to that case: call this with a single-row
 * array.
 */
export function aggregateBatch(rows: readonly BatchScoreRow[]): BatchAggregate {
  const sums: CaseCounters = { ...ZERO_COUNTERS };
  let casesPassed = 0;
  let casesFailed = 0;
  let casesErrored = 0;

  for (const row of rows) {
    if (!row.finished) continue;
    if (row.pass === null) {
      casesErrored += 1;
      continue; // errored: no numerator, no denominator — see the doc block.
    }
    if (row.pass) casesPassed += 1;
    else casesFailed += 1;

    sums.must_find_total += row.must_find_total;
    sums.must_find_matched += row.must_find_matched;
    sums.must_not_flag_total += row.must_not_flag_total;
    sums.noise_findings += row.noise_findings;
    sums.findings_total += row.findings_total;
    sums.grounding_kept += row.grounding_kept;
    sums.grounding_total += row.grounding_total;
  }

  // --- recall: Σ must_find_matched / Σ must_find_total ---------------------
  const recall = sums.must_find_total === 0 ? null : sums.must_find_matched / sums.must_find_total;

  // --- precision: 1 − (Σ noise_findings / Σ findings_total) ----------------
  // A produced finding matching NOTHING is ignored, not counted as noise: the
  // dataset records what the user judged, not every true positive in the diff,
  // so counting unmatched findings would measure dataset incompleteness (§4.6).
  const precision =
    sums.findings_total === 0 ? null : 1 - sums.noise_findings / sums.findings_total;

  // --- citation_accuracy: Σ grounding_kept / Σ grounding_total -------------
  const citationAccuracy =
    sums.grounding_total === 0 ? null : sums.grounding_kept / sums.grounding_total;

  return {
    ...sums,
    recall,
    precision,
    citation_accuracy: citationAccuracy,
    cases_total: rows.length,
    cases_passed: casesPassed,
    cases_failed: casesFailed,
    cases_errored: casesErrored,
  };
}

// ===========================================================================
// §4.7 — case fingerprint (comparability)
// ===========================================================================

/**
 * Deterministic JSON: object keys sorted, array order preserved, `undefined`
 * handled exactly as `JSON.stringify` does (dropped in objects, `null` in
 * arrays) so two structurally equal blobs always serialise identically.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalize(v)));
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const v = source[key];
    if (v === undefined) continue; // matches JSON.stringify's object behaviour
    out[key] = canonicalize(v);
  }
  return out;
}

/**
 * `sha256(input_diff + '\0' + canonicalJson(input_meta) + '\0' +
 * canonicalJson(expected_output))`, first 16 hex chars (§4.7).
 *
 * Pure and deterministic. It is written into `eval_runs.actual_output` (C7) —
 * a blob this feature already owns — so comparability tracking needs NO extra
 * column and D1's one-migration budget is respected. Two batches are comparable
 * iff their multisets of `(case_id, case_fingerprint)` are equal (§5.2).
 */
export function caseFingerprint(
  inputDiff: string,
  inputMeta: unknown,
  expectedOutput: unknown,
): string {
  return createHash('sha256')
    .update(`${inputDiff}\0${canonicalJson(inputMeta)}\0${canonicalJson(expectedOutput)}`)
    .digest('hex')
    .slice(0, 16);
}

// ===========================================================================
// The module edge — validate the untyped jsonb blob ONCE, here
// ===========================================================================

/**
 * Parse an `eval_cases.expected_output` blob (the frozen `EvalCase` types it
 * `z.unknown()`). `safeParse`, never `parse`: a hand-edited case with invalid
 * JSON is a user error the case editor renders as a badge (AC-14), not a 500.
 *
 * Callers parse ONCE at the edge and pass the result into `scoreCase`, so no
 * Zod validation ever runs inside the `O(F × E)` loop.
 */
export function parseExpectedOutput(blob: unknown): EvalExpectedOutput | null {
  const parsed = EvalExpectedOutput.safeParse(blob);
  return parsed.success ? parsed.data : null;
}
