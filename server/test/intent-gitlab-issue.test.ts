import { describe, it, expect, vi } from 'vitest';
import type { HostRepoRef, IntentDetailWrite, RepoRef, StoredIntentDetail } from '@devdigest/shared';
import {
  deriveIntent,
  type IntentDeriverDeps,
  type IntentPull,
} from '../src/modules/reviews/intent-deriver.js';
import { MockLLMProvider } from '../src/adapters/mocks.js';

/**
 * AC-23 — a GitLab MR's linked issue (body "Closes #N" or the MR's
 * same-project `closes_issues` relation) is fetched through the PR host and
 * fed to the intent classifier; any failure marks the source `unavailable`
 * without an error. GitHub keeps its `github.getIssue` path (host unused).
 */

const PR_ID = 'mr-1';

const CLASSIFICATION = {
  summary: 'Fix the checkout rounding bug.',
  in_scope: ['Rounding'],
  out_of_scope: [],
  risk_areas: [],
};

const GITLAB_REPO = {
  owner: 'group',
  name: 'project',
  fullName: 'group/sub/project',
  provider: 'gitlab',
  host: 'gitlab.com',
};

interface Opts {
  body: string | null;
  provider?: 'gitlab' | 'github';
  linked?: number | null;
  issue?: { title: string; body: string | null } | null | 'throw';
}

function makeDeps(opts: Opts) {
  const pull: IntentPull = {
    id: PR_ID,
    repoId: 'repo-1',
    number: 7,
    title: 'Fix rounding',
    author: 'dev',
    branch: 'fix/rounding',
    base: 'main',
    headSha: 'sha-1',
    body: opts.body,
  };
  let saved: IntentDetailWrite | undefined;
  let stored: StoredIntentDetail | undefined;

  const hostGetIssue = vi.fn(async (_ref: HostRepoRef, n: number) => {
    if (opts.issue === 'throw') throw new Error('GitLab 500');
    if (!opts.issue) return null;
    return { number: n, title: opts.issue.title, body: opts.issue.body, state: 'opened' };
  });
  const getLinkedIssueNumber = vi.fn(async () => opts.linked ?? null);
  const prHost = vi.fn(async () => ({ getIssue: hostGetIssue, getLinkedIssueNumber }));
  const githubGetIssue = vi.fn(async (_repo: RepoRef, n: number) => ({
    number: n,
    title: 'GitHub issue',
    body: 'gh body',
    state: 'open',
  }));
  const llm = new MockLLMProvider('openai', {
    structuredBySchema: { IntentClassification: CLASSIFICATION },
  });

  const deps: IntentDeriverDeps = {
    repo: {
      getPull: async () => pull,
      getRepo: async () =>
        opts.provider === 'github' ? { owner: 'acme', name: 'api' } : GITLAB_REPO,
      getPrFiles: async () => [{ path: 'src/a.ts', patch: '@@ -1 +1 @@\n-a\n+b' }],
      upsertIntentDetail: async (_id, input) => {
        saved = input;
        stored = {
          pr_id: PR_ID,
          intent: input.intent,
          in_scope: input.in_scope,
          out_of_scope: input.out_of_scope,
          risk_areas: input.risk_areas,
          confidence: input.confidence,
          sources: input.sources,
          model: input.model ?? null,
          head_sha: input.head_sha ?? null,
          generated_at: '2026-10-16T00:00:00.000Z',
        };
      },
      getIntentDetail: async () => stored,
    },
    github: async () => ({ getIssue: githubGetIssue }),
    prHost,
    git: { readFile: async () => '' },
    llm: async () => llm,
    resolveModel: async () => ({ provider: 'openai', model: 'm' }),
  };
  return { deps, llm, prHost, hostGetIssue, getLinkedIssueNumber, githubGetIssue, saved: () => saved };
}

function userMessage(llm: MockLLMProvider): string {
  const call = llm.calls.find((c) => c.method === 'completeStructured');
  expect(call).toBeDefined();
  const messages = (call!.req as { messages: { role: string; content: string }[] }).messages;
  return messages.find((m) => m.role === 'user')!.content;
}

describe('deriveIntent — GitLab linked issue (AC-23)', () => {
  it('"Closes #12" in the MR body → issue 12 title/body reach the classifier', async () => {
    const t = makeDeps({
      body: 'Fixes the rounding. Closes #12',
      issue: { title: 'Rounding is off by a cent', body: 'Totals show 9.99 instead of 10.00' },
    });

    const detail = await deriveIntent(t.deps, 'ws-1', PR_ID);

    expect(t.prHost).toHaveBeenCalledWith('gitlab');
    expect(t.getLinkedIssueNumber).not.toHaveBeenCalled();
    const [ref, n] = t.hostGetIssue.mock.calls[0]!;
    expect(n).toBe(12);
    expect(ref).toMatchObject({ provider: 'gitlab', fullName: 'group/sub/project' });
    const msg = userMessage(t.llm);
    expect(msg).toContain('Rounding is off by a cent');
    expect(msg).toContain('Totals show 9.99 instead of 10.00');
    expect(detail.sources).toContainEqual({
      kind: 'linked_issue',
      ref: '#12',
      title: 'Rounding is off by a cent',
      status: 'fetched',
    });
    expect(t.githubGetIssue).not.toHaveBeenCalled();
  });

  it('relation-only: empty body, closes_issues → 12 → issue fetched', async () => {
    const t = makeDeps({
      body: null,
      linked: 12,
      issue: { title: 'Relation issue', body: 'From closes_issues' },
    });

    const detail = await deriveIntent(t.deps, 'ws-1', PR_ID);

    expect(t.getLinkedIssueNumber).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gitlab' }),
      7,
    );
    expect(userMessage(t.llm)).toContain('From closes_issues');
    expect(detail.sources).toContainEqual({
      kind: 'linked_issue',
      ref: '#12',
      title: 'Relation issue',
      status: 'fetched',
    });
  });

  it('issue fetch throwing → linked_issue unavailable, no error', async () => {
    const t = makeDeps({ body: 'Closes #12', issue: 'throw' });

    const detail = await deriveIntent(t.deps, 'ws-1', PR_ID);

    expect(detail.sources).toContainEqual({ kind: 'linked_issue', ref: '#12', status: 'unavailable' });
    expect(detail.confidence).toBe('low');
  });

  it('confidential/404 issue (host returns null) → unavailable', async () => {
    const t = makeDeps({ body: null, linked: 12, issue: null });

    const detail = await deriveIntent(t.deps, 'ws-1', PR_ID);

    expect(detail.sources).toContainEqual({ kind: 'linked_issue', ref: '#12', status: 'unavailable' });
  });

  it('no body link and no relation → no linked_issue source', async () => {
    const t = makeDeps({ body: null, linked: null });

    const detail = await deriveIntent(t.deps, 'ws-1', PR_ID);

    expect(detail.sources.some((s) => s.kind === 'linked_issue')).toBe(false);
    expect(t.hostGetIssue).not.toHaveBeenCalled();
  });

  it('GitHub repo → unchanged github.getIssue path, PR host never resolved', async () => {
    const t = makeDeps({ body: 'Closes #5', provider: 'github' });

    const detail = await deriveIntent(t.deps, 'ws-1', PR_ID);

    expect(t.githubGetIssue).toHaveBeenCalledWith({ owner: 'acme', name: 'api' }, 5);
    expect(t.prHost).not.toHaveBeenCalled();
    expect(detail.sources).toContainEqual({
      kind: 'linked_issue',
      ref: '#5',
      title: 'GitHub issue',
      status: 'fetched',
    });
  });
});
