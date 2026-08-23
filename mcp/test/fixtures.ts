/* Shared hermetic fixtures + fake DevDigestApi for the test suites.
   Contract types come in type-only (erased at runtime); the objects below are
   plain literals conforming to them. */

import type {
  AgentListItem,
  BlastResponse,
  Convention,
  ConventionListResponse,
  PrMeta,
  Repo,
  ReviewRecord,
  RunSummary,
} from '@devdigest/shared';
import type { DevDigestApi } from '../src/api.js';
import { ApiError } from '../src/api.js';

export const REPO: Repo = {
  id: 'repo-uuid-1',
  workspace_id: 'ws-1',
  owner: 'acme',
  name: 'payments-api',
  full_name: 'acme/payments-api',
  default_branch: 'main',
  clone_path: null,
  last_polled_at: null,
  created_by: null,
};

export const REPO_2: Repo = {
  ...REPO,
  id: 'repo-uuid-2',
  owner: 'globex',
  name: 'web',
  full_name: 'globex/web',
};

/** Same short name as REPO_2 under another owner — exercises suffix ambiguity. */
export const REPO_3: Repo = {
  ...REPO,
  id: 'repo-uuid-3',
  owner: 'acme',
  name: 'web',
  full_name: 'acme/web',
};

export const PULL: PrMeta = {
  id: 'pr-uuid-482',
  number: 482,
  title: 'Fix payment rounding',
  author: 'dev',
  branch: 'fix/rounding',
  base: 'main',
  head_sha: 'abc123',
  additions: 10,
  deletions: 2,
  files_count: 3,
  status: 'open',
};

export const AGENT: AgentListItem = {
  id: 'agent-uuid-1',
  name: 'Security Reviewer',
  description: 'Finds security issues',
  provider: 'openrouter',
  model: 'openai/gpt-4o-mini',
  system_prompt: 'You are a security reviewer.',
  output_schema: null,
  enabled: true,
  version: 1,
  strategy: 'single-pass',
  ci_fail_on: 'critical',
  repo_intel: true,
  skill_count: 2,
};

export const AGENT_2: AgentListItem = {
  ...AGENT,
  id: 'agent-uuid-2',
  name: 'Perf Reviewer',
  description: 'Finds performance issues',
  skill_count: 0,
};

export function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: 'run-uuid-1',
    agent_id: AGENT.id,
    agent_name: AGENT.name,
    provider: 'openrouter',
    model: 'openai/gpt-4o-mini',
    status: 'running',
    error: null,
    duration_ms: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    findings_count: null,
    grounding: null,
    ran_at: '2026-08-23T10:00:00.000Z',
    score: null,
    blockers: null,
    ...overrides,
  };
}

export function makeFinding(
  overrides: Partial<ReviewRecord['findings'][number]> = {},
): ReviewRecord['findings'][number] {
  return {
    id: 'finding-1',
    severity: 'WARNING',
    category: 'bug',
    title: 'Possible rounding error',
    file: 'src/pay.ts',
    start_line: 10,
    end_line: 12,
    rationale: 'Float math on money.',
    suggestion: 'Use integer cents.',
    confidence: 0.8,
    review_id: 'review-uuid-1',
    accepted_at: null,
    dismissed_at: null,
    ...overrides,
  };
}

export function makeReview(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    id: 'review-uuid-1',
    pr_id: PULL.id as string,
    agent_id: AGENT.id,
    run_id: 'run-uuid-1',
    agent_name: AGENT.name,
    kind: 'review',
    verdict: 'comment',
    summary: 'Mostly fine.',
    score: 61,
    model: 'openai/gpt-4o-mini',
    grounding: null,
    created_at: '2026-08-23T10:01:00.000Z',
    findings: [makeFinding()],
    ...overrides,
  };
}

export function makeConvention(overrides: Partial<Convention> = {}): Convention {
  return {
    id: 'conv-1',
    repo_id: REPO.id,
    category: 'naming',
    rule: 'Use snake_case for DB columns.',
    evidence_path: 'src/db/schema.ts',
    evidence_snippet: 'workspace_id: uuid()',
    evidence_start_line: 3,
    evidence_end_line: 3,
    confidence: 0.9,
    status: 'accepted',
    created_at: '2026-08-20T09:00:00.000Z',
    ...overrides,
  };
}

export const BLAST_RESPONSE: BlastResponse = {
  status: 'ok',
  reason: null,
  counts: { symbols: 1, callers: 1, endpoints: 1, crons: 0 },
  symbols: [
    {
      symbol: { name: 'roundCents', file: 'src/pay.ts', kind: 'function' },
      callers: [
        { file: 'src/routes/checkout.ts', line: 42, symbol: 'checkoutHandler', rank: 0.7 },
      ],
      endpoints_affected: ['POST /checkout'],
      crons_affected: [],
    },
  ],
  endpoints: [{ endpoint: 'POST /checkout', file: 'src/routes/checkout.ts', depth: 1 }],
  prior_prs: [
    {
      number: 471,
      title: 'Refactor payment rounding',
      author: 'dev',
      status: 'merged',
      files_overlap: ['src/pay.ts'],
    },
  ],
  summary: null,
};

export const CONVENTIONS_RESPONSE: ConventionListResponse = {
  conventions: [makeConvention()],
  stats: { sampledFileCount: 40, droppedCount: 3, lastScanAt: '2026-08-20T09:00:00.000Z' },
};

/** Fake DevDigestApi serving canned GET routes; unknown paths 404, posts recorded. */
export function fakeApi(
  routes: Record<string, unknown>,
  posts: Record<string, unknown> = {},
): DevDigestApi & { postCalls: Array<{ path: string; body: unknown }> } {
  const postCalls: Array<{ path: string; body: unknown }> = [];
  return {
    postCalls,
    async get<T>(path: string): Promise<T> {
      if (path in routes) return routes[path] as T;
      throw new ApiError(`No route ${path}`, 404);
    },
    async post<T>(path: string, body?: unknown): Promise<T> {
      postCalls.push({ path, body });
      if (path in posts) return posts[path] as T;
      throw new ApiError(`No route ${path}`, 404);
    },
  };
}

/** Fake api whose every call fails as if the API were down. */
export function downApi(): DevDigestApi {
  const fail = async () => {
    throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3001'), { code: 'ECONNREFUSED' });
  };
  return { get: fail as DevDigestApi['get'], post: fail as DevDigestApi['post'] };
}
