/**
 * L06 Eval Pipeline — the system-prompt diff shown in Compare (spec §9.1).
 *
 * ---------------------------------------------------------------------------
 * PURE. Two strings in, `EvalPromptDiffLine[]` out. Deterministic.
 * ---------------------------------------------------------------------------
 * The only import is the shared Zod contract's type. This file is inside the
 * `eval-scoring-purity` dependency-cruiser rule's `from` pattern (`pnpm arch`,
 * `error`-severity): no `db/`, no `adapters/`, no `fastify`, no composition
 * root, no Node I/O builtin. In particular it does NOT shell out to `git diff`
 * and does NOT pull in a diff library — a prompt diff is a decision the product
 * makes about its own data, and `child_process` is exactly what the purity rule
 * exists to keep out.
 *
 * ---------------------------------------------------------------------------
 * WHY LCS, AND WHY THE CLIENT GETS LINES AND NOT HTML
 * ---------------------------------------------------------------------------
 * Line-level LCS is the smallest algorithm that produces a diff a human reads
 * as "what changed" rather than "everything after the first edit". The output
 * is plain data (`kind` + `text`), so the client owns the rendering: escaped
 * plain text in a monospace block with a leading `+`/`−` glyph, i.e. never
 * colour alone (§9.1, AC-45). No markup is produced here, which also means no
 * HTML-injection surface: a system prompt is operator-authored but still gets
 * escaped downstream, not here.
 *
 * ---------------------------------------------------------------------------
 * THE TWO BOUNDS, AND WHY BOTH ARE NEEDED
 * ---------------------------------------------------------------------------
 *  1. `MAX_PROMPT_DIFF_LINES` bounds the PAYLOAD. `EvalCompare.prompt_diff` is
 *     inlined in a JSON response; without a cap a 3000-line prompt rewritten
 *     wholesale would serialise 6000 objects into one compare response.
 *  2. `MAX_LCS_CELLS` bounds the WORK. LCS is `O(n × m)` in time and memory;
 *     3000 × 3000 is nine million cells on the event loop for a screen that
 *     renders a text box. Above the bound the function degrades to an honest
 *     "whole prompt replaced" diff instead of hanging.
 *
 * The common prefix and suffix are trimmed BEFORE the table is built — the
 * standard LCS optimisation, and it is exact, not an approximation (a common
 * prefix/suffix is part of some optimal alignment). It is also what makes the
 * work bound almost unreachable in practice: editing one line of a 3000-line
 * prompt leaves a 1 × 1 table, not a 3000 × 3000 one. Without it, that edit
 * would trip bound 2 and be reported as a wholesale replacement of two
 * near-identical prompts — the worst possible answer.
 *
 * Neither bound is hit by a realistic system prompt (a long one is a few
 * hundred lines), so the normal path always returns the FULL alignment with
 * every unchanged line as context and no elisions.
 */

import type { EvalPromptDiffLine } from '@devdigest/shared';

/**
 * Hard cap on emitted lines. Chosen against the real payload, not a round
 * number: a system prompt in this codebase is tens of lines, the largest
 * plausible one is a few hundred, and 400 lines of `{kind, text}` is well under
 * 100 KB even with long lines — small enough to inline in the compare response
 * and large enough that no realistic prompt is ever truncated.
 *
 * A caller that wants to tell the user "there was more" can compare
 * `prompt_diff.length` against this value; no synthetic marker line is emitted,
 * because a `context` line renders as prompt CONTENT and a fake one would read
 * as part of the operator's prompt.
 */
export const MAX_PROMPT_DIFF_LINES = 400;

/**
 * Context lines kept either side of a change when — and only when — the full
 * alignment does not fit under `MAX_PROMPT_DIFF_LINES`. Three is the unified
 * diff default.
 */
export const PROMPT_DIFF_CONTEXT_LINES = 3;

/**
 * Largest LCS table this module will build (`n × m` cells, one `Uint32Array`
 * entry each ⇒ ~4 MB at the bound). Above it, the two prompts are reported as
 * a wholesale replacement rather than aligned.
 */
export const MAX_LCS_CELLS = 1_000_000;

/** Split on `\n`, tolerating CRLF, so a line ending never shows up as a change. */
function toLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\r\n/g, '\n').split('\n');
}

/**
 * A line-level diff of two system prompts.
 *
 * Emission order inside a change block is REMOVED before ADDED, matching
 * unified diff, so the client can render `−` above `+` without re-sorting.
 */
export function promptDiff(base: string, head: string): EvalPromptDiffLine[] {
  const a = toLines(base);
  const b = toLines(head);

  // Trim the identical head and tail; only the disagreeing middle needs a table.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const middle =
    (midA.length + 1) * (midB.length + 1) > MAX_LCS_CELLS
      ? wholesaleReplacement(midA, midB)
      : alignByLcs(midA, midB);

  const full: EvalPromptDiffLine[] = [];
  for (let i = 0; i < prefix; i += 1) full.push({ kind: 'context', text: a[i] ?? '' });
  for (const line of middle) full.push(line);
  for (let i = a.length - suffix; i < a.length; i += 1) {
    full.push({ kind: 'context', text: a[i] ?? '' });
  }

  if (full.length <= MAX_PROMPT_DIFF_LINES) return full;

  // Degenerate case only: drop context far from any change so that the CHANGES
  // survive the cap rather than being pushed off the end by unchanged prose.
  const compressed = keepContextAroundChanges(full, PROMPT_DIFF_CONTEXT_LINES);
  return compressed.length <= MAX_PROMPT_DIFF_LINES
    ? compressed
    : compressed.slice(0, MAX_PROMPT_DIFF_LINES);
}

// ===========================================================================
// LCS
// ===========================================================================

/**
 * Classic `O(n × m)` LCS length table walked forwards to emit the alignment.
 * The table is a flat `Uint32Array` rather than a nested array: it is the whole
 * memory cost of this module, and a nested array of the same size costs an
 * order of magnitude more.
 */
function alignByLcs(a: readonly string[], b: readonly string[]): EvalPromptDiffLine[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + (j + 1)] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + (j + 1)] ?? 0);
    }
  }

  const out: EvalPromptDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'context', text: a[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + (j + 1)] ?? 0)) {
      // Tie goes to REMOVED first: deterministic, and it keeps a replaced block
      // reading as `−old` then `+new`.
      out.push({ kind: 'removed', text: a[i] ?? '' });
      i += 1;
    } else {
      out.push({ kind: 'added', text: b[j] ?? '' });
      j += 1;
    }
  }
  for (; i < n; i += 1) out.push({ kind: 'removed', text: a[i] ?? '' });
  for (; j < m; j += 1) out.push({ kind: 'added', text: b[j] ?? '' });
  return out;
}

/**
 * The over-`MAX_LCS_CELLS` fallback, applied to the disagreeing MIDDLE only:
 * report it as replaced wholesale. Only the first `MAX_PROMPT_DIFF_LINES` of
 * each side are materialised, so the pathological input never allocates the
 * arrays the cap exists to prevent.
 */
function wholesaleReplacement(a: readonly string[], b: readonly string[]): EvalPromptDiffLine[] {
  const half = Math.ceil(MAX_PROMPT_DIFF_LINES / 2);
  const out: EvalPromptDiffLine[] = [];
  for (const text of a.slice(0, half)) out.push({ kind: 'removed', text });
  for (const text of b.slice(0, half)) out.push({ kind: 'added', text });
  return out;
}

/** Keep every change plus `radius` context lines either side; drop the rest. */
function keepContextAroundChanges(
  lines: readonly EvalPromptDiffLine[],
  radius: number,
): EvalPromptDiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.kind === 'context') continue;
    const from = Math.max(0, i - radius);
    const to = Math.min(lines.length - 1, i + radius);
    for (let k = from; k <= to; k += 1) keep[k] = true;
  }
  return lines.filter((_line, i) => keep[i] === true);
}
