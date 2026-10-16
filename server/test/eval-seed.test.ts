/**
 * L06 — the seeded eval set's §11 invariants, asserted WITHOUT a database.
 *
 * `src/db/seed-evals.ts` is deliberately data-only: it exports `SEED_EVAL_CASES`
 * as a plain array and writes nothing, so this file can assert every invariant
 * with **no Postgres, no container, no network and no API key** (AC-37, AC-39).
 * That property is itself asserted below ("the import graph stays hermetic") —
 * the moment `seed-evals.ts` imports `db/client.ts` or drizzle, this whole file
 * stops being runnable in `pnpm verify:l06`.
 *
 * What is covered (spec `specs/06-eval-pipeline.md` §11, AC-37 + AC-40):
 *
 *  1. `expected_output` parses as `EvalExpectedOutput` (C3);
 *  2. `parseUnifiedDiff(inputDiff).files.length >= 1` — the parser NEVER throws,
 *     a malformed diff silently yields `files: []` (`adapters/git/diff-parser.ts`),
 *     so the assertion is on the count and not on a `try`/`catch`;
 *  3. every `must_find` expectation's `[start_line, end_line]` intersects a hunk
 *     of ITS OWN case's diff;
 *  4. names are unique within the owner;
 *  plus `length >= 8` with both kinds present (AC-37), and `input_meta` parsing
 *  as `EvalPrMeta` (C4) — the runner `safeParse`s it and falls back to `{}` on
 *  failure, so a malformed seed meta would otherwise degrade silently.
 *
 * Hermetic (no `.it.` segment in the file name), in the `smart-diff-helpers` /
 * `brief-helpers` style.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { EvalExpectedOutput, EvalPrMeta } from '@devdigest/shared';
import { SEED_EVAL_CASES } from '../src/db/seed-evals.js';
import { parseUnifiedDiff } from '../src/adapters/git/diff-parser.js';
import { intervalsIntersect, normalizePath } from '../src/modules/eval/scoring.js';

// ---------------------------------------------------------------- helpers

/**
 * New-side line numbers of the **added** (`+`) lines, per file, walking the raw
 * diff with exactly the cursor rules `parseUnifiedDiff` uses: an added line
 * consumes one new-side line, a deletion consumes none, anything else is
 * context and advances the cursor.
 *
 * `parseUnifiedDiff` cannot answer this — its `hunk.newLineNumbers` covers
 * context AND added lines, which is the right input for the grounding gate but
 * too weak for the "lands on a real change" invariant asserted below.
 */
function addedLinesByFile(raw: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file: string | null = null;
  let inHunk = false;
  let cursor = 0;

  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git')) {
      file = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '').trim();
      if (p !== '/dev/null') file = p;
      continue;
    }
    if (line.startsWith('--- ')) continue;

    const hh = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hh) {
      cursor = Number(hh[1]);
      inHunk = true;
      continue;
    }
    if (!file || !inHunk) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      let set = out.get(file);
      if (!set) {
        set = new Set<number>();
        out.set(file, set);
      }
      set.add(cursor);
      cursor++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // deletion: consumes no new-side line
    } else {
      cursor++;
    }
  }
  return out;
}

/** `[lo, hi]` of an expectation, honouring §4.2's "missing `end_line` defaults to `start_line`". */
const expRange = (e: { start_line: number; end_line?: number | null }): [number, number] => {
  const end = e.end_line ?? e.start_line;
  return [Math.min(e.start_line, end), Math.max(e.start_line, end)];
};

const mustFindCases = SEED_EVAL_CASES.filter((c) => c.expectedOutput.kind === 'must_find');

// ------------------------------------------------------- AC-37: the set

describe('SEED_EVAL_CASES — set composition (AC-37)', () => {
  it('holds at least 8 cases', () => {
    expect(SEED_EVAL_CASES.length).toBeGreaterThanOrEqual(8);
  });

  it('contains at least one must_find and at least one must_not_flag', () => {
    const kinds = SEED_EVAL_CASES.map((c) => c.expectedOutput.kind);
    // Both kinds are mandatory: with only `must_find` cases precision is pinned
    // at 1.0 and can never move (§4.6, C11), so the harness could not detect a
    // new false positive at all.
    expect(kinds).toContain('must_find');
    expect(kinds).toContain('must_not_flag');
  });

  it('has unique case names within each owner (§11 invariant 4)', () => {
    // `(workspace_id, owner_id, name)` is the seed's select-guard key and there
    // is no unique constraint behind it — a duplicate would insert twice.
    const seen = new Map<string, string[]>();
    for (const c of SEED_EVAL_CASES) {
      const names = seen.get(c.ownerAgentName) ?? [];
      names.push(c.name);
      seen.set(c.ownerAgentName, names);
    }
    for (const [owner, names] of seen) {
      expect(new Set(names).size, `duplicate case name for owner ${owner}`).toBe(names.length);
    }
  });

  it('keeps the import graph hermetic — no db/, no adapters, no I/O (AC-37)', () => {
    // This is what lets the whole file run with no Postgres. `seed.ts` is the
    // only module allowed to turn these values into rows.
    //
    // Anchored at column 0 on purpose: the fixture diffs are template literals
    // full of `import ... from '../db'` lines, and every one of them is indented
    // by its diff marker (` `, `+`, `-`) or introduced by an `@@` header, so only
    // real top-level imports of THIS module can match.
    const src = readFileSync(new URL('../src/db/seed-evals.ts', import.meta.url), 'utf8');
    const specifiers = [...src.matchAll(/^import\s[^\n]*?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(specifiers).toEqual(['@devdigest/shared']);
  });
});

// ------------------------------------------- C3 / C4: contract validity

describe('SEED_EVAL_CASES — every case parses against the contracts', () => {
  it.each(SEED_EVAL_CASES)(
    '$name — expectedOutput parses as EvalExpectedOutput (§11 invariant 1, C3)',
    (c) => {
      const parsed = EvalExpectedOutput.safeParse(c.expectedOutput);
      // ZodError is matched by SHAPE, never `instanceof` (zod is vendored twice).
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    },
  );

  it.each(SEED_EVAL_CASES)('$name — inputMeta parses as EvalPrMeta (C4)', (c) => {
    // The runner `safeParse`s `input_meta` and silently falls back to `{}`, so a
    // malformed seed meta would quietly strip `title`/`body` from the prompt
    // instead of failing loudly.
    const parsed = EvalPrMeta.safeParse(c.inputMeta);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});

// ------------------------------------- §11 invariant 2: the diff parses

describe('SEED_EVAL_CASES — every diff parses to at least one file (§11 invariant 2)', () => {
  it.each(SEED_EVAL_CASES)('$name', (c) => {
    // `parseUnifiedDiff` never throws: bad input yields `files: []`, which the
    // runner reports as a permanently-erroring `empty_diff` case (AC-47). The
    // assertion therefore has to be on the count, not on an exception.
    const parsed = parseUnifiedDiff(c.inputDiff);
    expect(parsed.files.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------- AC-40 / §11 invariant 3: the range is groundable

describe('AC-40 — every must_find expectation intersects a hunk of its own diff', () => {
  it('the seed set actually contains must_find cases to check', () => {
    expect(mustFindCases.length).toBeGreaterThan(0);
  });

  it.each(mustFindCases)('$name', (c) => {
    const parsed = parseUnifiedDiff(c.inputDiff);

    for (const exp of c.expectedOutput.expectations) {
      const file = parsed.files.find((f) => normalizePath(f.path) === normalizePath(exp.file));
      expect(file, `${c.name}: expectation names '${exp.file}', absent from its own diff`).toBeDefined();

      const [lo, hi] = expRange(exp);
      const hit = file!.hunks.some((h) =>
        intervalsIntersect(lo, hi, h.newStart, h.newStart + Math.max(h.newLines, 1) - 1),
      );
      // An expectation outside its own hunks is ungroundable: the grounding gate
      // would drop the correct answer and pin this case's recall at 0 forever.
      expect(
        hit,
        `${c.name}: lines ${lo}-${hi} of '${exp.file}' intersect no hunk of its own diff`,
      ).toBe(true);
    }
  });
});

/**
 * STRONGER THAN AC-40, deliberately asserted separately so relaxing it is an
 * explicit edit rather than a silent side effect of touching the block above.
 *
 * AC-40 only requires the range to intersect a hunk — but a hunk's new-side
 * coverage includes CONTEXT lines. A `must_find` expectation parked on
 * unchanged context is technically groundable while asserting a defect on code
 * the PR did not introduce; the agent has no reason to report it, so the case
 * fails forever and drags recall down. Every seeded `must_find` therefore has
 * to land on at least one ADDED line.
 */
describe('beyond AC-40 — every must_find expectation covers an added line', () => {
  it.each(mustFindCases)('$name', (c) => {
    const added = addedLinesByFile(c.inputDiff);

    for (const exp of c.expectedOutput.expectations) {
      const key = [...added.keys()].find((p) => normalizePath(p) === normalizePath(exp.file));
      expect(key, `${c.name}: '${exp.file}' adds no lines at all`).toBeDefined();

      const lines = added.get(key!)!;
      const [lo, hi] = expRange(exp);
      let hit = false;
      for (let n = lo; n <= hi && !hit; n++) hit = lines.has(n);

      expect(
        hit,
        `${c.name}: lines ${lo}-${hi} of '${exp.file}' cover no ADDED line (added: ${[...lines].join(', ')})`,
      ).toBe(true);
    }
  });
});
