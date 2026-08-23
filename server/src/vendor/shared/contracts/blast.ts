import { z } from 'zod';
import { ChangedSymbol } from './brief.js';

/**
 * L04 — Blast Radius (spec: docs/plans/l04-blast-radius.md).
 *
 * API response for GET /pulls/:id/blast. EXTENDS the frozen composite
 * `BlastRadius` in contracts/brief.ts (which is the PR-Brief block with a
 * required LLM `summary`): this file is additive per the vendored-contracts
 * rule — brief.ts stays untouched; `ChangedSymbol` is reused from there.
 *
 * The feature is fully deterministic (zero LLM calls): data comes from the
 * repo-intel persistent index (symbols / resolved references / file_facts /
 * file_edges) + local pull_requests/pr_files. `summary` is reserved for a
 * future LLM step and is ALWAYS null today.
 */

/**
 * ok       — full index, data computed.
 * partial  — partial index, data computed but may be incomplete (see reason).
 * degraded — index unusable / repo-intel disabled: arrays are empty, reason
 *            explains how to fix (the server NEVER falls back to AST/clone
 *            parsing at request time).
 * empty    — index fine, but the changed files declare no symbols.
 */
export const BlastStatus = z.enum(['ok', 'partial', 'degraded', 'empty']);
export type BlastStatus = z.infer<typeof BlastStatus>;

/** One call site reaching a changed symbol. `symbol` = the enclosing caller. */
export const BlastCallerRef = z.object({
  file: z.string(),
  /** 1-based line of the reference. */
  line: z.number().int(),
  /** Enclosing caller symbol name (falls back to the file's basename). */
  symbol: z.string(),
  /** file_rank.rank of the caller file (ordering weight). */
  rank: z.number(),
});
export type BlastCallerRef = z.infer<typeof BlastCallerRef>;

/** Per-changed-symbol impact: callers (≤20, rank desc) + reachable facts. */
export const BlastSymbolImpact = z.object({
  symbol: ChangedSymbol,
  callers: z.array(BlastCallerRef),
  /** "METHOD /path" from file_facts of this symbol's caller files. */
  endpoints_affected: z.array(z.string()),
  crons_affected: z.array(z.string()),
});
export type BlastSymbolImpact = z.infer<typeof BlastSymbolImpact>;

/** Flat endpoint union: depth 1 = caller files, depth 2 = reverse imports. */
export const BlastEndpointRef = z.object({
  endpoint: z.string(),
  file: z.string(),
  depth: z.number().int(),
});
export type BlastEndpointRef = z.infer<typeof BlastEndpointRef>;

/** A prior PR in the same repo whose files overlap this PR's files. */
export const BlastPriorPr = z.object({
  number: z.number().int(),
  title: z.string(),
  author: z.string(),
  status: z.string(),
  files_overlap: z.array(z.string()),
});
export type BlastPriorPr = z.infer<typeof BlastPriorPr>;

export const BlastResponse = z.object({
  status: BlastStatus,
  /** Explanation for partial/degraded/empty. */
  reason: z.string().nullish(),
  counts: z.object({
    symbols: z.number().int(),
    callers: z.number().int(),
    endpoints: z.number().int(),
    crons: z.number().int(),
  }),
  symbols: z.array(BlastSymbolImpact),
  endpoints: z.array(BlastEndpointRef),
  prior_prs: z.array(BlastPriorPr),
  /** Reserved for a future LLM summary step — always null today. */
  summary: z.string().nullish(),
});
export type BlastResponse = z.infer<typeof BlastResponse>;
