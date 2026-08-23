/* mappers.ts — pure domain: own-zod output schemas + mapping functions from
   the API's contract shapes to the concise structured results the tools
   return. Contract types arrive as `import type` ONLY (erased at runtime) —
   every runtime schema below is defined fresh with this package's zod, per
   Claude Code's 25k-token MCP output cap: only needed fields, `limit` +
   `has_more`/`truncated` on lists. */

import { z } from 'zod';
import type {
  AgentListItem,
  BlastResponse,
  ConventionListResponse,
  ReviewRecord,
  RunSummary,
} from '@devdigest/shared';

// ---------------------------------------------------------------- agents ----

export const AgentOut = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string(),
  enabled: z.boolean(),
  skill_count: z.number().int(),
});
export type AgentOut = z.infer<typeof AgentOut>;

export const AgentsOutput = z.object({
  agents: z.array(AgentOut),
  total: z.number().int(),
});
export type AgentsOutput = z.infer<typeof AgentsOutput>;

export function mapAgents(agents: AgentListItem[]): AgentsOutput {
  return {
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      provider: a.provider,
      model: a.model,
      enabled: a.enabled,
      skill_count: a.skill_count,
    })),
    total: agents.length,
  };
}

// -------------------------------------------------------------- findings ----

export const SeverityOut = z.enum(['CRITICAL', 'WARNING', 'SUGGESTION']);
export type SeverityOut = z.infer<typeof SeverityOut>;

const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, WARNING: 1, SUGGESTION: 2 };

/** Concise fields always present; detailed fields optional (format: 'detailed'). */
export const FindingOut = z.object({
  severity: SeverityOut,
  category: z.string(),
  title: z.string(),
  file: z.string(),
  start_line: z.number().int(),
  agent_name: z.string().nullable(),
  end_line: z.number().int().optional(),
  rationale: z.string().optional(),
  suggestion: z.string().nullable().optional(),
  confidence: z.number().optional(),
  accepted: z.boolean().optional(),
  dismissed: z.boolean().optional(),
  review_id: z.string().optional(),
});
export type FindingOut = z.infer<typeof FindingOut>;

export const ReviewOut = z.object({
  review_id: z.string(),
  agent_name: z.string().nullable(),
  verdict: z.string().nullable(),
  score: z.number().int().nullable(),
  findings_count: z.number().int(),
  created_at: z.string(),
});
export type ReviewOut = z.infer<typeof ReviewOut>;

export const FindingsOutput = z.object({
  repo: z.string(),
  pr_number: z.number().int(),
  /** Reviews still in flight — a hint that more findings may arrive. */
  running_runs: z.number().int(),
  reviews: z.array(ReviewOut),
  findings: z.array(FindingOut),
  total_findings: z.number().int(),
  has_more: z.boolean(),
  /** Forward-leading note for non-error empty results. */
  message: z.string().optional(),
});
export type FindingsOutput = z.infer<typeof FindingsOutput>;

export interface MapFindingsOptions {
  repo: string;
  prNumber: number;
  /** Canonical agent name (already resolved) — filters to that agent's reviews. */
  agentName?: string;
  severity?: SeverityOut;
  format?: 'concise' | 'detailed';
  limit?: number;
}

type FindingRecordT = ReviewRecord['findings'][number];

function toFindingOut(
  f: FindingRecordT,
  agentName: string | null,
  format: 'concise' | 'detailed',
): FindingOut {
  const concise: FindingOut = {
    severity: f.severity,
    category: f.category,
    title: f.title,
    file: f.file,
    start_line: f.start_line,
    agent_name: agentName,
  };
  if (format === 'concise') return concise;
  return {
    ...concise,
    end_line: f.end_line,
    rationale: f.rationale,
    suggestion: f.suggestion ?? null,
    confidence: f.confidence,
    accepted: f.accepted_at != null,
    dismissed: f.dismissed_at != null,
    review_id: f.review_id,
  };
}

function sortBySeverity<T extends { severity: string }>(findings: T[]): T[] {
  return [...findings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
  );
}

export function mapFindings(
  reviews: ReviewRecord[],
  runs: RunSummary[],
  opts: MapFindingsOptions,
): FindingsOutput {
  const format = opts.format ?? 'concise';
  const limit = opts.limit ?? 20;

  const wanted = opts.agentName?.toLowerCase();
  const scoped =
    wanted === undefined
      ? reviews
      : reviews.filter((r) => (r.agent_name ?? '').toLowerCase() === wanted);

  const all = scoped.flatMap((r) =>
    r.findings
      .filter((f) => opts.severity === undefined || f.severity === opts.severity)
      .map((f) => toFindingOut(f, r.agent_name ?? null, format)),
  );
  const sorted = sortBySeverity(all);

  return {
    repo: opts.repo,
    pr_number: opts.prNumber,
    running_runs: runs.filter((r) => r.status === 'running').length,
    reviews: scoped.map((r) => ({
      review_id: r.id,
      agent_name: r.agent_name ?? null,
      verdict: r.verdict,
      score: r.score,
      findings_count: r.findings.length,
      created_at: r.created_at,
    })),
    findings: sorted.slice(0, limit),
    total_findings: sorted.length,
    has_more: sorted.length > limit,
  };
}

// ------------------------------------------------------------------- run ----

const RUN_FINDINGS_LIMIT = 20;

export const RunDoneOutput = z.object({
  status: z.literal('done'),
  run_id: z.string(),
  agent_name: z.string().nullable(),
  verdict: z.string().nullable(),
  score: z.number().int().nullable(),
  summary: z.string().nullable(),
  blockers: z.number().int().nullable(),
  findings_count: z.number().int(),
  findings: z.array(FindingOut),
  truncated: z.boolean(),
});
export type RunDoneOutput = z.infer<typeof RunDoneOutput>;

export const RunTimeoutOutput = z.object({
  status: z.literal('timeout'),
  run_id: z.string(),
  repo: z.string(),
  pr_number: z.number().int(),
  agent_name: z.string().nullable(),
  message: z.string(),
});
export type RunTimeoutOutput = z.infer<typeof RunTimeoutOutput>;

export const RunOutput = z.discriminatedUnion('status', [RunDoneOutput, RunTimeoutOutput]);
export type RunOutput = z.infer<typeof RunOutput>;

export function mapRunDone(run: RunSummary, review: ReviewRecord): RunDoneOutput {
  const agentName = run.agent_name ?? review.agent_name ?? null;
  const sorted = sortBySeverity(review.findings).map((f) => toFindingOut(f, agentName, 'concise'));
  return {
    status: 'done',
    run_id: run.run_id,
    agent_name: agentName,
    verdict: review.verdict,
    score: review.score,
    summary: review.summary,
    blockers: run.blockers,
    findings_count: review.findings.length,
    findings: sorted.slice(0, RUN_FINDINGS_LIMIT),
    truncated: review.findings.length > RUN_FINDINGS_LIMIT,
  };
}

// ----------------------------------------------------------- conventions ----

export const ConventionStatusOut = z.enum(['pending', 'accepted', 'rejected']);

export const ConventionOut = z.object({
  id: z.string(),
  category: z.string(),
  rule: z.string(),
  status: ConventionStatusOut,
  confidence: z.number(),
  evidence_path: z.string(),
});
export type ConventionOut = z.infer<typeof ConventionOut>;

export const ConventionsOutput = z.object({
  repo: z.string(),
  conventions: z.array(ConventionOut),
  total: z.number().int(),
  has_more: z.boolean(),
  stats: z
    .object({
      sampled_file_count: z.number().int(),
      dropped_count: z.number().int(),
      last_scan_at: z.string(),
    })
    .nullable(),
  /** Forward-leading note for non-error empty results. */
  message: z.string().optional(),
});
export type ConventionsOutput = z.infer<typeof ConventionsOutput>;

export interface MapConventionsOptions {
  status?: 'pending' | 'accepted' | 'rejected' | 'all';
  limit?: number;
}

export function mapConventions(
  repo: string,
  resp: ConventionListResponse,
  opts: MapConventionsOptions = {},
): ConventionsOutput {
  const status = opts.status ?? 'all';
  const limit = opts.limit ?? 50;
  const filtered =
    status === 'all' ? resp.conventions : resp.conventions.filter((c) => c.status === status);
  return {
    repo,
    conventions: filtered.slice(0, limit).map((c) => ({
      id: c.id,
      category: c.category,
      rule: c.rule,
      status: c.status,
      confidence: c.confidence,
      evidence_path: c.evidence_path,
    })),
    total: filtered.length,
    has_more: filtered.length > limit,
    stats: resp.stats
      ? {
          sampled_file_count: resp.stats.sampledFileCount,
          dropped_count: resp.stats.droppedCount,
          last_scan_at: resp.stats.lastScanAt,
        }
      : null,
  };
}

// ---------------------------------------------------------- blast radius ----

/** Caller strings kept per symbol — token economy over completeness. */
const BLAST_CALLERS_LIMIT = 10;

export const BlastSymbolOut = z.object({
  name: z.string(),
  file: z.string(),
  kind: z.string(),
  /** "file:line (enclosing caller)" — capped at BLAST_CALLERS_LIMIT. */
  callers: z.array(z.string()),
  callers_total: z.number().int(),
  endpoints: z.array(z.string()),
  crons: z.array(z.string()),
});
export type BlastSymbolOut = z.infer<typeof BlastSymbolOut>;

export const BlastPriorPrOut = z.object({
  number: z.number().int(),
  title: z.string(),
  author: z.string(),
  status: z.string(),
  files_overlap: z.array(z.string()),
});
export type BlastPriorPrOut = z.infer<typeof BlastPriorPrOut>;

export const BlastRadiusOutput = z.object({
  repo: z.string(),
  pr_number: z.number().int(),
  /** degraded/partial/empty are NORMAL results (reason explains), not errors. */
  status: z.enum(['ok', 'partial', 'degraded', 'empty']),
  reason: z.string().optional(),
  counts: z.object({
    symbols: z.number().int(),
    callers: z.number().int(),
    endpoints: z.number().int(),
    crons: z.number().int(),
  }),
  symbols: z.array(BlastSymbolOut),
  /** "METHOD /path" union (direct callers + reverse imports), deduped. */
  endpoints: z.array(z.string()),
  prior_prs: z.array(BlastPriorPrOut),
});
export type BlastRadiusOutput = z.infer<typeof BlastRadiusOutput>;

export function mapBlast(repo: string, prNumber: number, resp: BlastResponse): BlastRadiusOutput {
  return {
    repo,
    pr_number: prNumber,
    status: resp.status,
    reason: resp.reason ?? undefined,
    counts: resp.counts,
    symbols: resp.symbols.map((s) => ({
      name: s.symbol.name,
      file: s.symbol.file,
      kind: s.symbol.kind,
      callers: s.callers
        .slice(0, BLAST_CALLERS_LIMIT)
        .map((c) => `${c.file}:${c.line} (${c.symbol})`),
      callers_total: s.callers.length,
      endpoints: s.endpoints_affected,
      crons: s.crons_affected,
    })),
    endpoints: [...new Set(resp.endpoints.map((e) => e.endpoint))],
    prior_prs: resp.prior_prs.map((p) => ({
      number: p.number,
      title: p.title,
      author: p.author,
      status: p.status,
      files_overlap: p.files_overlap,
    })),
  };
}
