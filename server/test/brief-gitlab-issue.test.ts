import { describe, it, expect, vi } from 'vitest';
import type { ChatMessage, HostRepoRef, LLMProvider, RepoRef } from '@devdigest/shared';
import { BriefService, type BriefServiceDeps } from '../src/modules/brief/service.js';

/**
 * AC-23 — the PR Brief re-fetches a GitLab MR's linked issue through the PR
 * host (body "Closes #N", else the same-project `closes_issues` relation). A
 * failed fetch is a `linked_issue` missing input, never an error. GitHub keeps
 * its `github.getIssue` path. Hermetic: every dependency is a fake; the model
 * call records its prompt and then fails, so the test needs no brief fixture.
 */

const PR_ID = 'mr-1';

interface Opts {
  body: string | null;
  provider?: 'gitlab' | 'github';
  linked?: number | null;
  issue?: { title: string; body: string | null } | null | 'throw';
}

function makeService(opts: Opts) {
  const prompts: ChatMessage[][] = [];
  const llm = {
    id: 'openai',
    completeStructured: vi.fn(async (req: { messages: ChatMessage[] }) => {
      prompts.push(req.messages);
      throw new Error('model offline');
    }),
  } as unknown as LLMProvider;

  const hostGetIssue = vi.fn(async (_ref: HostRepoRef, n: number) => {
    if (opts.issue === 'throw') throw new Error('GitLab 500');
    if (!opts.issue) return null;
    return { number: n, title: opts.issue.title, body: opts.issue.body, state: 'opened' };
  });
  const getLinkedIssueNumber = vi.fn(async () => opts.linked ?? null);
  const prHost = vi.fn(async () => ({ getIssue: hostGetIssue, getLinkedIssueNumber }));
  const githubGetIssue = vi.fn(async (_repo: RepoRef, n: number) => ({
    number: n,
    title: 'GitHub issue title',
    body: 'GitHub issue body',
    state: 'open',
  }));

  const deps: BriefServiceDeps = {
    repo: {
      getPull: async () => ({
        id: PR_ID,
        repoId: 'repo-1',
        number: 7,
        title: 'Fix rounding',
        author: 'dev',
        branch: 'fix/rounding',
        base: 'main',
        headSha: 'sha-1',
        body: opts.body,
      }),
      getRepo: async () =>
        opts.provider === 'github'
          ? { owner: 'acme', name: 'api' }
          : {
              owner: 'group',
              name: 'project',
              fullName: 'group/sub/project',
              provider: 'gitlab',
              host: 'gitlab.com',
            },
      getPrFiles: async () => [
        { path: 'src/a.ts', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' },
      ],
    },
    briefRepo: {
      getBrief: async () => undefined,
      upsertBrief: async () => {},
      latestReviewRowsForPull: async () => [],
      findingsForReviews: async () => [],
      blockersForRuns: async () => new Map(),
      getPrSpend: async () => ({ costUsd: null, tokensIn: null, tokensOut: null }),
    },
    intent: { get: async () => null },
    blast: {
      get: async () => ({
        status: 'empty',
        reason: 'not indexed',
        counts: { symbols: 0, callers: 0, endpoints: 0, crons: 0 },
        symbols: [],
        endpoints: [],
        prior_prs: [],
        summary: null,
      }),
    },
    github: async () => ({ getIssue: githubGetIssue }),
    prHost,
    git: { readFile: async () => '' },
    llm: async () => llm,
    resolveModel: async () => ({ provider: 'openai', model: 'm' }),
  };

  const promptText = () => prompts.flat().map((m) => m.content).join('\n');
  return {
    service: new BriefService(deps),
    prHost,
    hostGetIssue,
    getLinkedIssueNumber,
    githubGetIssue,
    promptText,
  };
}

describe('BriefService.regenerate — GitLab linked issue (AC-23)', () => {
  it('"Closes #12" in the MR body → issue 12 title/body reach the brief prompt (wrapped)', async () => {
    const t = makeService({
      body: 'Closes #12',
      issue: { title: 'Rounding is off by a cent', body: 'Totals show 9.99' },
    });

    const detail = await t.service.regenerate('ws-1', PR_ID);

    expect(t.prHost).toHaveBeenCalledWith('gitlab');
    expect(t.hostGetIssue).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gitlab', fullName: 'group/sub/project' }),
      12,
    );
    const text = t.promptText();
    expect(text).toContain('Linked issue #12');
    expect(text).toContain('Rounding is off by a cent');
    expect(text).toContain('Totals show 9.99');
    expect(text).toContain('<untrusted');
    expect(detail.missing_inputs.some((m) => m.input === 'linked_issue')).toBe(false);
    expect(t.githubGetIssue).not.toHaveBeenCalled();
  });

  it('relation-only: empty body, closes_issues → 12 → issue in prompt', async () => {
    const t = makeService({
      body: null,
      linked: 12,
      issue: { title: 'Relation issue', body: 'From closes_issues' },
    });

    await t.service.regenerate('ws-1', PR_ID);

    expect(t.getLinkedIssueNumber).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gitlab' }),
      7,
    );
    expect(t.promptText()).toContain('From closes_issues');
  });

  it('issue fetch throwing → linked_issue missing input, no error', async () => {
    const t = makeService({ body: 'Closes #12', issue: 'throw' });

    const detail = await t.service.regenerate('ws-1', PR_ID);

    expect(detail.missing_inputs).toContainEqual(
      expect.objectContaining({ input: 'linked_issue' }),
    );
    expect(t.promptText()).not.toContain('Linked issue #12');
  });

  it('confidential/404 issue (host returns null) → linked_issue missing input', async () => {
    const t = makeService({ body: null, linked: 12, issue: null });

    const detail = await t.service.regenerate('ws-1', PR_ID);

    expect(detail.missing_inputs).toContainEqual(
      expect.objectContaining({ input: 'linked_issue' }),
    );
  });

  it('GitHub repo → unchanged github.getIssue path, PR host never resolved', async () => {
    const t = makeService({ body: 'Fixes #5', provider: 'github' });

    await t.service.regenerate('ws-1', PR_ID);

    expect(t.githubGetIssue).toHaveBeenCalledWith({ owner: 'acme', name: 'api' }, 5);
    expect(t.prHost).not.toHaveBeenCalled();
    expect(t.promptText()).toContain('GitHub issue body');
  });
});
