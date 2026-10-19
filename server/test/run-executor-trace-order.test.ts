import { describe, it, expect } from 'vitest';
import type { HostGitClient } from '@devdigest/shared';
import { ReviewRunExecutor } from '../src/modules/reviews/run-executor.js';
import type { ReviewRepository, PullRow, ReviewRow, FindingRow } from '../src/modules/reviews/repository.js';
import type { AgentRow } from '../src/db/rows.js';
import type { Container } from '../src/platform/container.js';
import type * as schema from '../src/db/schema.js';
import { RunBus } from '../src/platform/sse.js';
import { MockLLMProvider } from '../src/adapters/mocks.js';

/**
 * TRACE_BEFORE_STATUS: on every exit path the run's trace is persisted BEFORE
 * its agent_runs row turns terminal, so a reader that sees done/failed can
 * always fetch GET /runs/:id/trace (the reverse order made it 404 in that
 * window and flaked reviews.it / gitlab-feature-parity.it under load).
 * Hermetic — port-level fakes, no DB.
 */

const WS = 'ws-1';
const PATCH = '@@ -1,2 +1,3 @@\n line one\n+added line\n line two';

const pull = { id: 'pr-1', workspaceId: WS, repoId: 'repo-1', number: 7, title: 'PR', author: 'dev', branch: 'feat/x', base: 'main', headSha: 'cafebabe', body: null } as PullRow;
const repo = { id: 'repo-1', workspaceId: WS, owner: 'acme', name: 'project', fullName: 'acme/project', provider: 'github', host: 'github.com', defaultBranch: 'main' } as typeof schema.repos.$inferSelect;
const agent = { id: 'agent-0', workspaceId: WS, name: 'Agent', provider: 'openai', model: 'gpt-4.1', systemPrompt: 'Review.', strategy: 'single-pass', ciFailOn: 'critical', repoIntel: false, attachedDocPaths: [], enabled: true, version: 1 } as AgentRow;

async function run(opts: { files: Array<{ path: string; patch: string | null; patchOmitted: string | null }>; llmFails?: boolean }) {
  const writes: string[] = [];
  const llm = new MockLLMProvider('openai', {
    structured: { verdict: 'approve', summary: 'ok', score: 90, findings: [] },
  });
  const repoFake = {
    getPrFiles: async () => opts.files,
    insertReview: async (values: Record<string, unknown>) => ({ ...values, id: 'review-1' }) as unknown as ReviewRow,
    insertFindings: async () => [] as FindingRow[],
    markReviewed: async () => undefined,
    completeAgentRun: async (_runId: string, values: { status: string }) => {
      writes.push(`status:${values.status}`);
    },
    saveRunTrace: async () => {
      writes.push('trace');
    },
  } as unknown as ReviewRepository;

  const container = {
    runBus: new RunBus(),
    git: {
      fetchPullHead: async () => undefined,
      diff: async () => {
        throw new Error('fatal: no merge base'); // force the pr_files fallback
      },
    } as unknown as HostGitClient,
    llm: async () => {
      if (opts.llmFails) throw new Error('OPENAI_API_KEY not set');
      return llm;
    },
    intent: {
      getOrDeriveFresh: async () => {
        throw new Error('intent disabled in this test');
      },
    },
    skillsRepo: { resolveAgentSkills: async () => [] },
  } as unknown as Container;

  const executor = new ReviewRunExecutor(container, repoFake, {} as Container['agentsRepo']);
  await executor.executeRuns(WS, pull, repo, [{ agent, runId: 'run-0' }]);
  return writes;
}

describe('ReviewRunExecutor — trace is persisted before the terminal status', () => {
  it('success path: trace, then status done', async () => {
    const writes = await run({ files: [{ path: 'src/a.ts', patch: PATCH, patchOmitted: null }] });
    expect(writes).toEqual(['trace', 'status:done']);
  });

  it('pre-work failure (no reviewable diff): trace, then status failed', async () => {
    const writes = await run({ files: [] });
    expect(writes).toEqual(['trace', 'status:failed']);
  });

  it('per-agent failure (LLM unavailable): trace, then status failed', async () => {
    const writes = await run({ files: [{ path: 'src/a.ts', patch: PATCH, patchOmitted: null }], llmFails: true });
    expect(writes).toEqual(['trace', 'status:failed']);
  });
});
