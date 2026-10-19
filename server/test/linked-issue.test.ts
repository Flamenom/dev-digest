import { describe, it, expect, vi } from 'vitest';
import type { HostRepoRef, IssueMeta, RepoRef } from '@devdigest/shared';
import {
  extractIssueRef,
  fetchLinkedIssue,
  gitRepoRef,
  type LinkedIssueDeps,
} from '../src/modules/_shared/linked-issue.js';

const GITHUB_REPO = { owner: 'acme', name: 'shop' };
const GITLAB_REPO = {
  owner: 'group',
  name: 'project',
  fullName: 'group/sub/project',
  provider: 'gitlab',
  host: 'gitlab.com',
};

interface Opts {
  ghIssue?: IssueMeta | 'throw';
  linked?: number | null | 'throw';
  hostIssue?: { title: string; body: string | null } | null | 'throw';
  prHostThrows?: boolean;
}

function makeDeps(opts: Opts = {}) {
  const ghGetIssue = vi.fn(async (_repo: RepoRef, _n: number): Promise<IssueMeta> => {
    if (opts.ghIssue === 'throw' || !opts.ghIssue) throw new Error('GitHub 404');
    return opts.ghIssue;
  });
  const getLinkedIssueNumber = vi.fn(async (_ref: HostRepoRef, _n: number) => {
    if (opts.linked === 'throw') throw new Error('GitLab 500');
    return opts.linked ?? null;
  });
  const hostGetIssue = vi.fn(async (_ref: HostRepoRef, n: number) => {
    if (opts.hostIssue === 'throw') throw new Error('GitLab 500');
    if (!opts.hostIssue) return null;
    return { number: n, title: opts.hostIssue.title, body: opts.hostIssue.body, state: 'opened' };
  });
  const prHost = vi.fn(async () => {
    if (opts.prHostThrows) throw new Error('no token');
    return { getIssue: hostGetIssue, getLinkedIssueNumber } as never;
  });
  const deps: LinkedIssueDeps = { github: async () => ({ getIssue: ghGetIssue }), prHost };
  return { deps, ghGetIssue, getLinkedIssueNumber, hostGetIssue, prHost };
}

describe('extractIssueRef', () => {
  it('matches closes/fixes/resolves #N case-insensitively, first match wins', () => {
    expect(extractIssueRef('Fixes #12 and closes #13')).toBe(12);
    expect(extractIssueRef('RESOLVES #7')).toBe(7);
    expect(extractIssueRef('see #5')).toBeUndefined();
    expect(extractIssueRef(null)).toBeUndefined();
  });
});

describe('fetchLinkedIssue — GitHub', () => {
  it('fetches the body-declared issue via github.getIssue with a plain {owner,name} ref', async () => {
    const { deps, ghGetIssue, prHost } = makeDeps({
      ghIssue: { number: 3, title: 'Bug', body: null } as unknown as IssueMeta,
    });
    const res = await fetchLinkedIssue(deps, GITHUB_REPO, 1, 'Closes #3');
    expect(res).toEqual({ status: 'fetched', ref: '#3', title: 'Bug', body: null });
    expect(ghGetIssue).toHaveBeenCalledWith({ owner: 'acme', name: 'shop' }, 3);
    expect(prHost).not.toHaveBeenCalled();
  });

  it('no body link ⇒ undefined; fetch failure ⇒ unavailable', async () => {
    const { deps } = makeDeps({ ghIssue: 'throw' });
    expect(await fetchLinkedIssue(deps, GITHUB_REPO, 1, 'no link')).toBeUndefined();
    expect(await fetchLinkedIssue(deps, GITHUB_REPO, 1, 'fixes #9')).toEqual({
      status: 'unavailable',
      ref: '#9',
    });
  });
});

describe('fetchLinkedIssue — GitLab (AC-23)', () => {
  it('falls back to the MR closes_issues relation when the body has no link', async () => {
    const { deps, getLinkedIssueNumber, hostGetIssue } = makeDeps({
      linked: 4,
      hostIssue: { title: 'Rounding', body: 'details' },
    });
    const res = await fetchLinkedIssue(deps, GITLAB_REPO, 7, null);
    expect(res).toEqual({ status: 'fetched', ref: '#4', title: 'Rounding', body: 'details' });
    expect(getLinkedIssueNumber).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gitlab', fullName: 'group/sub/project' }),
      7,
    );
    expect(hostGetIssue).toHaveBeenCalledWith(expect.objectContaining({ provider: 'gitlab' }), 4);
  });

  it('host getIssue null or throw ⇒ unavailable; no link anywhere ⇒ undefined', async () => {
    expect(
      await fetchLinkedIssue(makeDeps({ hostIssue: null }).deps, GITLAB_REPO, 7, 'Closes #2'),
    ).toEqual({ status: 'unavailable', ref: '#2' });
    expect(
      await fetchLinkedIssue(makeDeps({ hostIssue: 'throw' }).deps, GITLAB_REPO, 7, 'Closes #2'),
    ).toEqual({ status: 'unavailable', ref: '#2' });
    expect(await fetchLinkedIssue(makeDeps({ linked: null }).deps, GITLAB_REPO, 7, null)).toBeUndefined();
  });

  it('host/relation failure ⇒ unavailable only for a body-declared link', async () => {
    expect(
      await fetchLinkedIssue(makeDeps({ prHostThrows: true }).deps, GITLAB_REPO, 7, 'Closes #2'),
    ).toEqual({ status: 'unavailable', ref: '#2' });
    expect(
      await fetchLinkedIssue(makeDeps({ linked: 'throw' }).deps, GITLAB_REPO, 7, null),
    ).toBeUndefined();
  });
});

describe('gitRepoRef', () => {
  it('always returns a full host-aware ref (GitHub and GitLab)', () => {
    expect(gitRepoRef(GITHUB_REPO)).toMatchObject({
      owner: 'acme',
      name: 'shop',
      provider: 'github',
      host: 'github.com',
    });
    expect(gitRepoRef(GITLAB_REPO)).toMatchObject({
      provider: 'gitlab',
      fullName: 'group/sub/project',
      host: 'gitlab.com',
    });
  });
});
