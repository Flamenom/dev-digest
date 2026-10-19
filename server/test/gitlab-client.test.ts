/**
 * RestGitLabClient (plan T3): GraphQL list pagination + batched stats, state
 * mapping, REST detail pagination, file mapping, head-unchanged short-circuit,
 * linked issue, token check and project error codes. Hermetic fake fetch.
 */
import { describe, it, expect } from 'vitest';
import type { HostRepoRef } from '@devdigest/shared';
import { RestGitLabClient } from '../src/adapters/gitlab/client.js';
import { MockGitClient, MockGitLabClient } from '../src/adapters/mocks.js';
import { fakeFetch, fakeSleep, json, type FakeRequest } from './fixtures/gitlab/fake-fetch.js';
import mrNode from './fixtures/gitlab/graphql-open-mrs-node.json';
import restMr from './fixtures/gitlab/rest-merge-request.json';
import restDiffs from './fixtures/gitlab/rest-diffs.json';
import restCommits from './fixtures/gitlab/rest-commits.json';
import restProject from './fixtures/gitlab/rest-project.json';
import closesIssues from './fixtures/gitlab/rest-closes-issues.json';
import restIssue from './fixtures/gitlab/rest-issue.json';

const TOKEN = 'glpat-SECRET';
const FULL = 'space-profit/platform/crm-frontend';
const ENC = encodeURIComponent(FULL);
const REF: HostRepoRef = {
  provider: 'gitlab',
  host: 'gitlab.com',
  owner: 'space-profit/platform',
  name: 'crm-frontend',
  fullName: FULL,
};

type Handler = (req: FakeRequest) => Response | Promise<Response>;

function client(handler: Handler, token: string | null = TOKEN) {
  const { fetch, calls } = fakeFetch(handler);
  const c = new RestGitLabClient({ token, fetch, sleep: fakeSleep().sleep });
  return { c, calls };
}

const isGql = (r: FakeRequest) => r.url.pathname === '/api/graphql';
const restPath = (r: FakeRequest) => r.url.pathname.replace('/api/v4', '');
const rawPath = (r: FakeRequest) => r.url.href.replace('https://gitlab.com/api/v4', '').split('?')[0];

function node(i: number, extra: Record<string, unknown> = {}) {
  return { ...mrNode, iid: String(i), title: `MR ${i}`, ...extra };
}

async function caught(p: Promise<unknown>): Promise<Error & { code?: string; statusCode?: number }> {
  try {
    await p;
  } catch (err) {
    return err as Error & { code?: string; statusCode?: number };
  }
  throw new Error('expected a rejection');
}

describe('listPullRequests (GraphQL, AC-18/19/20/22/50/54)', () => {
  it('120 open MRs → 2 GraphQL requests, 0 diffs/commits, all mapped', async () => {
    const all = Array.from({ length: 120 }, (_, k) => {
      const i = k + 1;
      if (i === 7) return node(i, { diffStatsSummary: null });
      if (i === 8) return node(i, { state: 'locked', draft: false });
      if (i === 9) return node(i, { diffHeadSha: null });
      return node(i);
    });
    const { c, calls } = client((req) => {
      expect(isGql(req)).toBe(true);
      const { after, first, fullPath } = req.body!.variables as { after: string | null; first: number; fullPath: string };
      expect(first).toBe(100);
      expect(fullPath).toBe(FULL);
      const start = after === null ? 0 : 100;
      const nodes = all.slice(start, start + 100);
      return json({
        data: {
          project: {
            mergeRequests: {
              pageInfo: { hasNextPage: start + 100 < all.length, endCursor: start === 0 ? 'c1' : 'c2' },
              nodes,
            },
          },
        },
      });
    });
    const pulls = await c.listPullRequests(REF);
    expect(calls).toHaveLength(2);
    expect(calls.every(isGql)).toBe(true);
    expect(calls.some((r) => /diffs|commits/.test(r.url.pathname))).toBe(false);
    expect(calls[0]!.body!.query).not.toContain('changesCount');
    expect(pulls).toHaveLength(120);

    const five = pulls.find((p) => p.number === 5)!;
    expect(five).toMatchObject({
      title: 'MR 5',
      author: 'olena.dev',
      branch: 'feat/contact-import',
      base: 'main',
      head_sha: mrNode.diffHeadSha,
      additions: 120,
      deletions: 14,
      files_count: 6,
      stats_known: true,
      status: 'open',
      is_draft: true,
      opened_at: '2026-10-01T09:00:00Z',
    });
    expect(pulls.find((p) => p.number === 7)).toMatchObject({ stats_known: false, additions: 0, files_count: 0 });
    expect(pulls.find((p) => p.number === 8)).toMatchObject({ status: 'open', is_draft: false });
    expect(pulls.find((p) => p.number === 9)!.head_sha).toBe('');
  });

  it('project not visible: no token → gitlab_token_missing; token → gitlab_project_inaccessible', async () => {
    const h: Handler = () => json({ data: { project: null } });
    expect((await caught(client(h, null).c.listPullRequests(REF))).code).toBe('gitlab_token_missing');
    expect((await caught(client(h).c.listPullRequests(REF))).code).toBe('gitlab_project_inaccessible');
  });

  it('GraphQL 401 → gitlab_token_invalid without the token in the message', async () => {
    const err = await caught(
      client(() => json({ error: 'invalid_token', error_description: 'Token has expired.' }, 401)).c.listPullRequests(REF),
    );
    expect(err.code).toBe('gitlab_token_invalid');
    expect(err.message).not.toContain(TOKEN);
  });
});

describe('getPullStates', () => {
  it('chunks iids by 100 and maps states', async () => {
    const { c, calls } = client((req) => {
      const iids = req.body!.variables!.iids as string[];
      return json({
        data: {
          project: {
            mergeRequests: {
              nodes: iids.map((iid) => ({ iid, state: Number(iid) % 2 ? 'merged' : 'closed' })),
            },
          },
        },
      });
    });
    const states = await c.getPullStates(REF, Array.from({ length: 150 }, (_, i) => i + 1));
    expect(calls).toHaveLength(2);
    expect((calls[0]!.body!.variables!.iids as string[]).length).toBe(100);
    expect((calls[1]!.body!.variables!.iids as string[]).length).toBe(50);
    expect(states).toHaveLength(150);
    expect(states[0]).toEqual({ number: 1, status: 'merged' });
    expect(states[1]).toEqual({ number: 2, status: 'closed' });
    expect(await c.getPullStates(REF, [])).toEqual([]);
    expect(calls).toHaveLength(2);
  });
});

describe('getPullRequestDetail (REST, AC-21/22/24/33)', () => {
  const mrPath = `/projects/${ENC}/merge_requests/5`;

  it('an MR with 1 200 files over 12 diff pages → 1 200 files', async () => {
    const { c, calls } = client((req) => {
      const p = rawPath(req);
      if (p === mrPath) return json(restMr);
      if (p === `${mrPath}/diffs`) {
        const page = Number(req.url.searchParams.get('page'));
        expect(req.url.searchParams.get('per_page')).toBe('100');
        const files = Array.from({ length: 100 }, (_, i) => ({
          old_path: `f${page}-${i}.ts`,
          new_path: `f${page}-${i}.ts`,
          diff: '@@ -1 +1,2 @@\n a\n+b\n',
          new_file: false,
          renamed_file: false,
          deleted_file: false,
        }));
        return json(files, 200, { 'x-next-page': page < 12 ? String(page + 1) : '' });
      }
      if (p === `${mrPath}/commits`) return json(restCommits, 200, { 'x-next-page': '' });
      throw new Error(`unexpected ${p}`);
    });
    const res = await c.getPullRequestDetail(REF, 5);
    expect(res.kind).toBe('full');
    if (res.kind !== 'full') return;
    expect(res.detail.files).toHaveLength(1200);
    expect(new Set(res.detail.files.map((f) => f.path)).size).toBe(1200);
    expect(calls.filter((r) => restPath(r).endsWith('/diffs'))).toHaveLength(12);
    expect(res.detail).toMatchObject({ additions: 1200, deletions: 0, files_count: 1200, stats_known: true });
    expect(calls[0]!.url.href).toContain(`/projects/${ENC}/`); // slashes encoded as %2F
    expect(ENC).toContain('%2F');
  });

  it('maps renamed / too_large / deleted files, commits oldest-first, exact stats via GraphQL', async () => {
    const { c, calls } = client((req) => {
      if (isGql(req)) {
        expect(req.body!.variables).toEqual({ fullPath: FULL, iid: '5' });
        return json({
          data: { project: { mergeRequest: { diffStatsSummary: { additions: 5000, deletions: 3, fileCount: 4 } } } },
        });
      }
      const p = rawPath(req);
      if (p === mrPath) return json(restMr);
      if (p === `${mrPath}/diffs`) return json(restDiffs, 200, { 'x-next-page': '' });
      if (p === `${mrPath}/commits`) return json(restCommits, 200, { 'x-next-page': '' });
      throw new Error(`unexpected ${p}`);
    });
    const res = await c.getPullRequestDetail(REF, 5);
    if (res.kind !== 'full') throw new Error('expected full');
    const d = res.detail;
    const [renamed, huge, deleted, ci] = d.files;
    expect(renamed).toMatchObject({
      path: 'src/contacts/import.ts',
      previous_path: 'src/contacts/old-import.ts',
      change_type: 'renamed',
      additions: 2,
      deletions: 1,
      patch_omitted: null,
    });
    expect(huge).toMatchObject({ path: 'fixtures/huge.json', change_type: 'added', patch: null, patch_omitted: 'too_large' });
    expect(deleted).toMatchObject({ change_type: 'deleted', deletions: 2, previous_path: null });
    expect(ci).toMatchObject({ change_type: 'modified', additions: 1 });
    expect(d.files_omitted_by_host).toBe(1);
    expect(d).toMatchObject({
      number: 5,
      body: 'Imports contacts from CSV. Closes #12.',
      is_draft: true,
      status: 'open',
      head_sha: restMr.sha,
      additions: 5000,
      deletions: 3,
      files_count: 4,
      stats_known: true,
    });
    expect(d.commits.map((x) => x.message.trim())).toEqual(['Add contact import', 'Wire import into CI']);
    expect(d.commits[0]).toMatchObject({ author: 'Olena', committed_at: '2026-10-01T09:00:00Z' });
    expect(calls.filter(isGql)).toHaveLength(1);
  });

  it('unlessHeadSha equal to the host SHA → unchanged, no diff/commit request', async () => {
    const { c, calls } = client((req) => {
      if (rawPath(req) === mrPath) return json(restMr);
      throw new Error(`unexpected ${req.url.pathname}`);
    });
    const res = await c.getPullRequestDetail(REF, 5, { unlessHeadSha: restMr.sha });
    expect(res.kind).toBe('unchanged');
    if (res.kind === 'unchanged') expect(res.meta).toMatchObject({ number: 5, head_sha: restMr.sha, is_draft: true });
    expect(calls).toHaveLength(1);
  });

  it('a different unlessHeadSha refetches', async () => {
    const { c } = client((req) => {
      const p = rawPath(req);
      if (p === mrPath) return json({ ...restMr, sha: null });
      return json([], 200, { 'x-next-page': '' });
    });
    const res = await c.getPullRequestDetail(REF, 5, { unlessHeadSha: 'old' });
    expect(res.kind).toBe('full');
    // `sha` null → diff_refs.head_sha
    if (res.kind === 'full') expect(res.detail.head_sha).toBe(restMr.diff_refs.head_sha);
  });
});

describe('issues (AC-23)', () => {
  it('getLinkedIssueNumber keeps only same-project closes_issues', async () => {
    const { c } = client((req) => {
      const p = rawPath(req);
      if (p === `/projects/${ENC}`) return json(restProject);
      if (p === `/projects/${ENC}/merge_requests/5/closes_issues`) return json(closesIssues, 200, { 'x-next-page': '' });
      throw new Error(`unexpected ${p}`);
    });
    expect(await c.getLinkedIssueNumber(REF, 5)).toBe(12);
  });

  it('getIssue maps title/body/state/labels; 404 → null', async () => {
    const { c } = client((req) =>
      rawPath(req).endsWith('/issues/12') ? json(restIssue) : json({ message: '404 Not found' }, 404),
    );
    expect(await c.getIssue(REF, 12)).toEqual({
      number: 12,
      title: 'Import contacts from CSV',
      body: 'Sales needs bulk import.',
      state: 'open',
      labels: ['crm', 'import'],
    });
    expect(await c.getIssue(REF, 13)).toBeNull();
  });
});

describe('checkToken (AC-2–5)', () => {
  const tokenHandler =
    (scopes: Response | (() => Response), user: () => Response = () => json({ username: 'olena' })): Handler =>
    (req) => {
      if (restPath(req) === '/user') return user();
      if (restPath(req) === '/personal_access_tokens/self') return typeof scopes === 'function' ? scopes() : scopes;
      throw new Error('unexpected');
    };

  it('valid token → username, sufficient scopes', async () => {
    const { c } = client(tokenHandler(() => json({ scopes: ['read_api', 'read_repository'] })));
    expect(await c.checkToken()).toEqual({
      ok: true,
      username: 'olena',
      scopes: ['read_api', 'read_repository'],
      missingScopes: [],
    });
  });

  it('`api` covers both read scopes', async () => {
    const { c } = client(tokenHandler(() => json({ scopes: ['api'] })));
    expect(await c.checkToken()).toMatchObject({ ok: true, missingScopes: [] });
  });

  it('read_user-only → missing scopes listed', async () => {
    const { c } = client(tokenHandler(() => json({ scopes: ['read_user'] })));
    expect(await c.checkToken()).toMatchObject({ ok: true, missingScopes: ['read_api', 'read_repository'] });
  });

  it('scopes endpoint 404 → scopes:null', async () => {
    const { c } = client(tokenHandler(() => json({ message: '404 Not Found' }, 404)));
    expect(await c.checkToken()).toEqual({ ok: true, username: 'olena', scopes: null, missingScopes: [] });
  });

  it('401 "Token has expired." → expired; revoked; invalid', async () => {
    const cases: [string, string][] = [
      ['Token has expired.', 'expired'],
      ['Token was revoked. You have to re-authorize from the user.', 'revoked'],
      ['Token is invalid', 'invalid'],
    ];
    for (const [desc, reason] of cases) {
      const { c } = client(
        tokenHandler(
          () => json({}),
          () => json({ error: 'invalid_token', error_description: desc }, 401),
        ),
      );
      const res = await c.checkToken();
      expect(res).toEqual({ ok: false, reason });
      expect(JSON.stringify(res)).not.toContain(TOKEN);
    }
  });

  it('no token → invalid without any request', async () => {
    const { c, calls } = client(() => json({}), null);
    expect(await c.checkToken()).toEqual({ ok: false, reason: 'invalid' });
    expect(calls).toHaveLength(0);
  });
});

describe('getProject (AC-13/14/52)', () => {
  it('maps the project and encodes the path as one segment', async () => {
    const { c, calls } = client(() => json(restProject));
    expect(await c.getProject('Space-Profit/Platform/CRM-Frontend')).toEqual({
      id: 1001,
      fullPath: FULL,
      defaultBranch: 'main',
      webUrl: `https://gitlab.com/${FULL}`,
    });
    expect(calls[0]!.url.href).toBe(
      'https://gitlab.com/api/v4/projects/Space-Profit%2FPlatform%2FCRM-Frontend',
    );
  });

  it('404 without a token → gitlab_token_missing (400); with a token → gitlab_project_inaccessible (404)', async () => {
    const h: Handler = () => json({ message: '404 Project Not Found' }, 404);
    const missing = await caught(client(h, null).c.getProject(FULL));
    expect(missing.code).toBe('gitlab_token_missing');
    expect(missing.statusCode).toBe(400);
    expect(missing.message).toMatch(/GitLab token/);
    const denied = await caught(client(h).c.getProject(FULL));
    expect(denied.code).toBe('gitlab_project_inaccessible');
    expect(denied.statusCode).toBe(404);
    expect(denied.message).toMatch(/project not found or token has no access/);
    const forbidden = await caught(client(() => json({ message: '403 Forbidden' }, 403)).c.getProject(FULL));
    expect(forbidden.code).toBe('gitlab_project_inaccessible');
  });

  it('401 → gitlab_token_invalid; no message carries the token', async () => {
    const err = await caught(client(() => json({ message: `401 Unauthorized ${TOKEN}` }, 401)).c.getProject(FULL));
    expect(err.code).toBe('gitlab_token_invalid');
    expect(err.message).not.toContain(TOKEN);
    const boom = await caught(client(() => new Response(`oops ${TOKEN}`, { status: 502 })).c.getProject(FULL));
    expect(boom.message).not.toContain(TOKEN);
  });
});

describe('test doubles', () => {
  it('MockGitLabClient records calls by endpoint kind and honours unlessHeadSha', async () => {
    const mock = new MockGitLabClient();
    await mock.listPullRequests(REF);
    const first = await mock.getPullRequestDetail(REF, 5);
    expect(first.kind).toBe('full');
    const again = await mock.getPullRequestDetail(REF, 5, { unlessHeadSha: 'f00dbabe5' });
    expect(again.kind).toBe('unchanged');
    expect(mock.callsOf('merge_requests')).toHaveLength(1);
    expect(mock.callsOf('diffs')).toHaveLength(1);
    expect(mock.callsOf('commits')).toHaveLength(1);
    mock.opts.errors = { merge_requests: new Error('down') };
    await expect(mock.listPullRequests(REF)).rejects.toThrow('down');
  });

  it('MockGitClient: host-aware clone paths + fetchPullHead recorder', async () => {
    const git = new MockGitClient();
    expect(git.clonePathFor({ owner: 'acme', name: 'web' })).toBe('/mock/clones/acme/web');
    expect(git.clonePathFor({ ...REF, provider: 'github', host: 'github.com', owner: 'acme', name: 'web' })).toBe(
      '/mock/clones/acme/web',
    );
    expect(git.clonePathFor(REF)).toBe('/mock/clones/@gitlab.com/space-profit/platform/crm-frontend');
    await git.fetchPullHead(REF, 5);
    expect(git.pullHeadFetches).toEqual([{ repo: REF, n: 5 }]);
  });
});
