import { describe, expect, it } from 'vitest';
import { ResolveError } from '../src/errors.js';
import { resolveAgent, resolvePull, resolveRepo } from '../src/resolve.js';
import { AGENT, AGENT_2, PULL, REPO, REPO_2, REPO_3, fakeApi } from './fixtures.js';

const api = fakeApi({
  '/repos': [REPO, REPO_2, REPO_3],
  [`/repos/${REPO.id}/pulls`]: [PULL, { ...PULL, id: 'pr-uuid-7', number: 7 }],
  '/agents': [AGENT, AGENT_2],
});

describe('resolveRepo', () => {
  it('matches uuid exactly', async () => {
    expect((await resolveRepo(api, 'repo-uuid-2')).full_name).toBe('globex/web');
  });

  it('matches full_name case-insensitively', async () => {
    expect((await resolveRepo(api, 'ACME/Payments-API')).id).toBe(REPO.id);
  });

  it('matches a unique short-name suffix', async () => {
    expect((await resolveRepo(api, 'payments-api')).id).toBe(REPO.id);
  });

  it('rejects an ambiguous short name, listing the matches', async () => {
    await expect(resolveRepo(api, 'web')).rejects.toThrowError(
      /ambiguous — use the full name.*globex\/web, acme\/web/s,
    );
  });

  it('rejects an unknown repo, listing known full_names', async () => {
    const err = await resolveRepo(api, 'nope/nothing').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResolveError);
    expect((err as Error).message).toBe(
      'Repo "nope/nothing" not found. Known repos: acme/payments-api, globex/web, acme/web.',
    );
  });
});

describe('resolvePull', () => {
  it('matches by PR number and guarantees an id', async () => {
    const pull = await resolvePull(api, REPO.id, 482, REPO.full_name);
    expect(pull.id).toBe('pr-uuid-482');
  });

  it('rejects a missing PR number, listing open PR numbers', async () => {
    const err = await resolvePull(api, REPO.id, 999, REPO.full_name).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResolveError);
    expect((err as Error).message).toBe(
      'PR #999 not found in acme/payments-api — open PRs: #482, #7.',
    );
  });

  it('explains when the repo has no PRs at all', async () => {
    const empty = fakeApi({ [`/repos/${REPO.id}/pulls`]: [] });
    await expect(resolvePull(empty, REPO.id, 1, REPO.full_name)).rejects.toThrowError(
      'PR #1 not found in acme/payments-api — the repo has no pull requests yet.',
    );
  });

  it('rejects a PR row without an internal id with refresh guidance', async () => {
    const noId = fakeApi({ [`/repos/${REPO.id}/pulls`]: [{ ...PULL, id: null }] });
    await expect(resolvePull(noId, REPO.id, 482, REPO.full_name)).rejects.toThrowError(
      /has no internal id yet — refresh the repo/,
    );
  });
});

describe('resolveAgent', () => {
  it('matches uuid exactly', async () => {
    expect((await resolveAgent(api, 'agent-uuid-2')).name).toBe('Perf Reviewer');
  });

  it('matches name case-insensitively', async () => {
    expect((await resolveAgent(api, 'security reviewer')).id).toBe(AGENT.id);
  });

  it('rejects an unknown agent, listing valid names + list_agents pointer', async () => {
    const err = await resolveAgent(api, 'Ghost').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResolveError);
    expect((err as Error).message).toBe(
      'Agent "Ghost" not found. Known agents: Security Reviewer, Perf Reviewer. Call devdigest_list_agents for details.',
    );
  });
});
