import { describe, it, expect } from 'vitest';
import type { HostGitClient, RunTrace } from '@devdigest/shared';
import { ReviewRunExecutor, NO_REVIEWABLE_DIFF } from '../src/modules/reviews/run-executor.js';
import type { ReviewRepository, PullRow, ReviewRow, FindingRow } from '../src/modules/reviews/repository.js';
import type { AgentRow } from '../src/db/rows.js';
import type { Container } from '../src/platform/container.js';
import type * as schema from '../src/db/schema.js';
import { RunBus } from '../src/platform/sse.js';
import { MockLLMProvider } from '../src/adapters/mocks.js';

/**
 * Hermetic run-executor tests for the fallback-diff outcomes (AC-31/AC-32):
 * the local git diff is forced to fail, so the diff is rebuilt from pr_files.
 * Fakes at the port level only — no DB, no network.
 */

const WS = 'ws-1';
const MODIFIED_PATCH = '@@ -1,2 +1,3 @@\n line one\n+added line\n line two';

type PrFile = { path: string; patch: string | null; patchOmitted: string | null };

function pullRow(): PullRow {
  return {
    id: 'pr-1',
    workspaceId: WS,
    repoId: 'repo-1',
    number: 17,
    title: 'MR',
    author: 'dev',
    branch: 'feat/x',
    base: 'main',
    headSha: 'cafebabe',
    body: null,
  } as PullRow;
}

function repoRow(provider: 'github' | 'gitlab'): typeof schema.repos.$inferSelect {
  return {
    id: 'repo-1',
    workspaceId: WS,
    owner: provider === 'gitlab' ? 'group' : 'acme',
    name: 'project',
    fullName: provider === 'gitlab' ? 'group/project' : 'acme/project',
    provider,
    host: provider === 'gitlab' ? 'gitlab.com' : 'github.com',
    defaultBranch: 'main',
  } as typeof schema.repos.$inferSelect;
}

function agentRow(id: string): AgentRow {
  return {
    id,
    workspaceId: WS,
    name: `Agent ${id}`,
    provider: 'openai',
    model: 'gpt-4.1',
    systemPrompt: 'Review.',
    strategy: 'single-pass',
    ciFailOn: 'critical',
    repoIntel: false,
    attachedDocPaths: [],
    enabled: true,
    version: 1,
  } as AgentRow;
}

async function run(opts: { provider: 'github' | 'gitlab'; files: PrFile[]; agents?: number }) {
  const llm = new MockLLMProvider('openai', {
    structured: { verdict: 'approve', summary: 'ok', score: 90, findings: [] },
  });
  let llmResolved = 0;
  const git = {
    fetchPullHead: async () => undefined,
    // Force the pr_files fallback (e.g. shallow clone lacks the merge base).
    diff: async () => {
      throw new Error('fatal: no merge base');
    },
  } as unknown as HostGitClient;

  const traces: Record<string, RunTrace> = {};
  const completed: Record<string, Record<string, unknown>> = {};
  let reviewsInserted = 0;
  const repoFake = {
    getPrFiles: async () => opts.files,
    insertReview: async (values: Record<string, unknown>) => {
      reviewsInserted++;
      return { ...values, id: 'review-1' } as unknown as ReviewRow;
    },
    insertFindings: async () => [] as FindingRow[],
    markReviewed: async () => undefined,
    completeAgentRun: async (runId: string, values: Record<string, unknown>) => {
      completed[runId] = values;
    },
    saveRunTrace: async (runId: string, trace: RunTrace) => {
      traces[runId] = trace;
    },
  } as unknown as ReviewRepository;

  const container = {
    runBus: new RunBus(),
    git,
    llm: async () => {
      llmResolved++;
      return llm;
    },
    intent: {
      getOrDeriveFresh: async () => {
        throw new Error('intent disabled in this test');
      },
    },
    skillsRepo: { resolveAgentSkills: async () => [] },
  } as unknown as Container;

  const jobs = Array.from({ length: opts.agents ?? 1 }, (_, i) => ({
    agent: agentRow(`agent-${i}`),
    runId: `run-${i}`,
  }));
  const executor = new ReviewRunExecutor(container, repoFake, {} as Container['agentsRepo']);
  await executor.executeRuns(WS, pullRow(), repoRow(opts.provider), jobs);

  return { llm, llmResolved, traces, completed, reviewsInserted, runIds: jobs.map((j) => j.runId) };
}

const logText = (trace: RunTrace | undefined) => (trace?.log ?? []).map((l) => l.msg).join('\n');

describe('ReviewRunExecutor — fallback diff outcomes', () => {
  it('records the host-omitted file count in the persisted trace and still reviews the rest (AC-31)', async () => {
    const { traces, completed, llm } = await run({
      provider: 'gitlab',
      files: [
        { path: 'src/a.ts', patch: MODIFIED_PATCH, patchOmitted: null },
        { path: 'big/one.json', patch: null, patchOmitted: 'too_large' },
        { path: 'big/two.json', patch: null, patchOmitted: 'too_large' },
      ],
    });

    expect(logText(traces['run-0'])).toContain('2 files not reviewed (diff unavailable)');
    expect(logText(traces['run-0'])).toContain('Diff source: fallback');
    expect(completed['run-0']).toMatchObject({ status: 'done' });
    expect(llm.calls.filter((c) => c.method === 'completeStructured')).toHaveLength(1);
  });

  it('all files omitted → every queued run fails with no_reviewable_diff and NO LLM call (AC-32)', async () => {
    const { llm, llmResolved, completed, traces, reviewsInserted, runIds } = await run({
      provider: 'gitlab',
      agents: 2,
      files: [
        { path: 'big/one.json', patch: null, patchOmitted: 'too_large' },
        { path: 'big/two.json', patch: null, patchOmitted: 'collapsed' },
      ],
    });

    expect(llm.calls).toHaveLength(0);
    expect(llmResolved).toBe(0);
    expect(reviewsInserted).toBe(0);
    for (const runId of runIds) {
      expect(completed[runId]).toMatchObject({ status: 'failed', error: NO_REVIEWABLE_DIFF });
      expect(String(completed[runId]!.error)).toMatch(/^no_reviewable_diff/);
      expect(logText(traces[runId])).toContain('2 files not reviewed (diff unavailable)');
      expect(logText(traces[runId])).toContain(NO_REVIEWABLE_DIFF);
    }
  });

  it('applies provider-agnostically: an empty GitHub diff also skips the model (Q5)', async () => {
    const { llm, completed } = await run({ provider: 'github', files: [] });

    expect(llm.calls).toHaveLength(0);
    expect(completed['run-0']).toMatchObject({ status: 'failed', error: NO_REVIEWABLE_DIFF });
  });
});
