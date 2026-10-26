/**
 * RestGitLabClient as `GitLabDiffVersionsHost` (plan gitlab-publish-outdated-findings
 * T3): bounded version listing (AC-6, NFR version bound), one version's files
 * mapped like the MR diff (AC-10), read retry policy and error mapping (AC-8),
 * redaction. Plus the pure mapper and the mock. Hermetic fake fetch + fake sleep.
 */
import { describe, it, expect } from 'vitest';
import type { HostRepoRef } from '@devdigest/shared';
import { RestGitLabClient } from '../src/adapters/gitlab/client.js';
import { mapDiffVersion } from '../src/adapters/gitlab/index.js';
import { MockGitLabClient } from '../src/adapters/mocks.js';
import { fakeFetch, fakeSleep, json, type FakeRequest } from './fixtures/gitlab/fake-fetch.js';

const TOKEN = 'glpat-VERSIONS-SECRET';
const FULL = 'space-profit/platform/crm-frontend';
const ENC = encodeURIComponent(FULL);
const MR = `/projects/${ENC}/merge_requests/42`;
const REF: HostRepoRef = {
  provider: 'gitlab',
  host: 'gitlab.com',
  owner: 'space-profit/platform',
  name: 'crm-frontend',
  fullName: FULL,
};
const DIFF_TEXT = '@@ -1,1 +1,2 @@\n context\n+const SECRET_DIFF_LINE = 1;';

const rawPath = (r: FakeRequest) => r.url.href.replace('https://gitlab.com/api/v4', '').split('?')[0];

function client(handler: (req: FakeRequest) => Response | Promise<Response>) {
  const { fetch, calls } = fakeFetch(handler);
  const { sleep, delays } = fakeSleep();
  const c = new RestGitLabClient({ token: TOKEN, fetch, sleep, random: () => 0.5 });
  return { c, calls, delays };
}

async function caught(p: Promise<unknown>): Promise<Error & { code?: string; statusCode?: number }> {
  try {
    await p;
  } catch (err) {
    return err as Error & { code?: string; statusCode?: number };
  }
  throw new Error('expected a rejection');
}

const rawVersion = (id: number) => ({
  id,
  head_commit_sha: `head${id}`,
  base_commit_sha: `base${id}`,
  start_commit_sha: `start${id}`,
  created_at: `2026-10-0${(id % 9) + 1}T00:00:00Z`,
  merge_request_id: 1,
  state: 'collected',
});

/** A versions endpoint with `pages` pages of one version each, `x-next-page` set until the last. */
function pagedVersions(pages: number) {
  return (req: FakeRequest) => {
    const page = Number(req.url.searchParams.get('page'));
    const headers: Record<string, string> = { 'x-next-page': page < pages ? String(page + 1) : '' };
    return json([rawVersion(1000 - page)], 200, headers);
  };
}

describe('mapDiffVersion (pure)', () => {
  it('maps the four fields and drops malformed entries', () => {
    expect(mapDiffVersion(rawVersion(7))).toEqual({
      id: 7,
      headSha: 'head7',
      baseSha: 'base7',
      startSha: 'start7',
      createdAt: '2026-10-08T00:00:00Z',
    });
    expect(mapDiffVersion({ ...rawVersion(7), id: 0 })).toBeNull();
    expect(mapDiffVersion({ ...rawVersion(7), id: -3 })).toBeNull();
    expect(mapDiffVersion({ ...rawVersion(7), head_commit_sha: null })).toBeNull();
    expect(mapDiffVersion({ ...rawVersion(7), base_commit_sha: 42 })).toBeNull();
    expect(mapDiffVersion(null)).toBeNull();
    expect(mapDiffVersion({ ...rawVersion(7), created_at: null })?.createdAt).toBe('');
  });
});

describe('RestGitLabClient.listMrDiffVersions', () => {
  it('3 pages → 3 GETs with per_page=100, mapped in host order, not truncated', async () => {
    const { c, calls } = client(pagedVersions(3));
    const out = await c.listMrDiffVersions(REF, 42, { maxPages: 20 });
    expect(calls).toHaveLength(3);
    expect(calls.every((r) => r.method === 'GET' && rawPath(r) === `${MR}/versions`)).toBe(true);
    expect(calls.map((r) => r.url.searchParams.get('per_page'))).toEqual(['100', '100', '100']);
    expect(calls.map((r) => r.url.searchParams.get('page'))).toEqual(['1', '2', '3']);
    expect(out.truncated).toBe(false);
    expect(out.versions.map((v) => v.id)).toEqual([999, 998, 997]);
  });

  it('25 pages with maxPages 20 → 20 GETs and truncated', async () => {
    const { c, calls } = client(pagedVersions(25));
    const out = await c.listMrDiffVersions(REF, 42, { maxPages: 20 });
    expect(calls).toHaveLength(20);
    expect(out.truncated).toBe(true);
    expect(out.versions).toHaveLength(20);
  });

  it('drops malformed entries from a page', async () => {
    const { c } = client(() => json([rawVersion(5), { id: 0 }, { ...rawVersion(4), start_commit_sha: null }]));
    const out = await c.listMrDiffVersions(REF, 42, { maxPages: 20 });
    expect(out.versions.map((v) => v.id)).toEqual([5]);
  });

  it.each([
    [401, 'gitlab_token_invalid'],
    [403, 'gitlab_project_inaccessible'],
    [404, 'gitlab_project_inaccessible'],
  ])('%i → %s, token never in the message', async (status, code) => {
    const { c, calls } = client(() => json({ message: `${status} denied` }, status));
    const err = await caught(c.listMrDiffVersions(REF, 42, { maxPages: 20 }));
    expect(err.code).toBe(code);
    expect(calls).toHaveLength(1);
    expect(err.message).not.toContain(TOKEN);
  });

  it('403 insufficient_scope → gitlab_token_insufficient_scope', async () => {
    const { c } = client(() => json({ error: 'insufficient_scope' }, 403));
    const err = await caught(c.listMrDiffVersions(REF, 42, { maxPages: 20 }));
    expect(err.code).toBe('gitlab_token_insufficient_scope');
  });

  it('an invalid iid throws before any fetch', async () => {
    const { c, calls } = client(() => json([]));
    const err = await caught(c.listMrDiffVersions(REF, 0, { maxPages: 20 }));
    expect(err.code).toBe('validation_error');
    expect(calls).toHaveLength(0);
  });
});

describe('RestGitLabClient.getMrDiffVersionFiles', () => {
  it('maps too_large / collapsed / empty / renamed / deleted files like the MR diff', async () => {
    const { c, calls } = client(() =>
      json({
        ...rawVersion(77),
        diffs: [
          { old_path: 'a.ts', new_path: 'a.ts', diff: DIFF_TEXT },
          { old_path: 'big.ts', new_path: 'big.ts', diff: '', too_large: true },
          { old_path: 'col.ts', new_path: 'col.ts', diff: DIFF_TEXT, collapsed: true },
          { old_path: 'empty.ts', new_path: 'empty.ts', diff: '' },
          { old_path: 'old/name.ts', new_path: 'new/name.ts', diff: DIFF_TEXT, renamed_file: true },
          { old_path: 'gone.ts', new_path: 'gone.ts', diff: '@@ -1 +0,0 @@\n-x', deleted_file: true },
        ],
      }),
    );
    const files = await c.getMrDiffVersionFiles(REF, 42, 77);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(rawPath(calls[0]!)).toBe(`${MR}/versions/77`);

    const by = (p: string) => files.find((f) => f.path === p)!;
    expect(by('a.ts')).toMatchObject({ patch: DIFF_TEXT, change_type: 'modified', patch_omitted: null, additions: 1 });
    expect(by('big.ts')).toMatchObject({ patch: null, patch_omitted: 'too_large' });
    expect(by('col.ts')).toMatchObject({ patch: null, patch_omitted: 'collapsed' });
    expect(by('empty.ts')).toMatchObject({ patch: null, patch_omitted: null });
    expect(by('new/name.ts')).toMatchObject({ change_type: 'renamed', previous_path: 'old/name.ts' });
    expect(by('gone.ts')).toMatchObject({ change_type: 'deleted', previous_path: null });
  });

  it('missing or non-array diffs → []', async () => {
    const { c } = client(() => json({ ...rawVersion(77) }));
    expect(await c.getMrDiffVersionFiles(REF, 42, 77)).toEqual([]);
    const { c: c2 } = client(() => json({ ...rawVersion(77), diffs: 'nope' }));
    expect(await c2.getMrDiffVersionFiles(REF, 42, 77)).toEqual([]);
  });

  it('503 then 200 is retried (read policy) and succeeds', async () => {
    let n = 0;
    const { c, calls, delays } = client(() =>
      n++ === 0 ? json({ message: 'unavailable' }, 503) : json({ ...rawVersion(77), diffs: [] }),
    );
    expect(await c.getMrDiffVersionFiles(REF, 42, 77)).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(delays).toHaveLength(1);
  });

  it('a network error → exactly 1 GET, then it throws (no retry)', async () => {
    const { c, calls } = client(() => {
      throw new TypeError('fetch failed');
    });
    const err = await caught(c.getMrDiffVersionFiles(REF, 42, 77));
    expect(calls).toHaveLength(1);
    expect(err.code).toBe('gitlab_comment_failed');
    expect(err.message).not.toContain(TOKEN);
  });

  it.each([
    [401, 'gitlab_token_invalid'],
    [403, 'gitlab_project_inaccessible'],
    [404, 'gitlab_project_inaccessible'],
  ])('%i → %s', async (status, code) => {
    const { c } = client(() => json({ message: `${status} ${DIFF_TEXT}` }, status));
    const err = await caught(c.getMrDiffVersionFiles(REF, 42, 77));
    expect(err.code).toBe(code);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain('SECRET_DIFF_LINE');
  });

  it.each([0, -1, 1.5, Number.NaN])('versionId %s throws before any fetch', async (id) => {
    const { c, calls } = client(() => json({ diffs: [] }));
    const err = await caught(c.getMrDiffVersionFiles(REF, 42, id));
    expect(err.code).toBe('validation_error');
    expect(calls).toHaveLength(0);
  });
});

describe('MockGitLabClient as GitLabDiffVersionsHost', () => {
  const v = (id: number) => ({ id, headSha: `h${id}`, baseSha: `b${id}`, startSha: `s${id}`, createdAt: '' });

  it('explicit [] when absent; bounded pages + truncated; recorded calls', async () => {
    const empty = new MockGitLabClient();
    expect(await empty.listMrDiffVersions(REF, 42, { maxPages: 20 })).toEqual({ versions: [], truncated: false });
    expect(empty.callsOf('mr_versions')).toHaveLength(1);

    const m = new MockGitLabClient({ versions: { 42: [v(3), v(2), v(1)] }, versionsPageSize: 1 });
    const out = await m.listMrDiffVersions(REF, 42, { maxPages: 2 });
    expect(out).toEqual({ versions: [v(3), v(2)], truncated: true });
    expect(m.callsOf('mr_versions')).toHaveLength(2);
  });

  it('version files: explicit [] vs an unknown version (404), scripted failures, invalid id', async () => {
    const boom = new Error('scripted');
    const m = new MockGitLabClient({
      versionFiles: { 5: [] },
      versionErrors: { mr_version: [boom] },
    });
    await expect(m.getMrDiffVersionFiles(REF, 42, 5)).rejects.toBe(boom);
    expect(await m.getMrDiffVersionFiles(REF, 42, 5)).toEqual([]);
    const err = await caught(m.getMrDiffVersionFiles(REF, 42, 6));
    expect(err.code).toBe('gitlab_project_inaccessible');
    expect(m.callsOf('mr_version')).toHaveLength(3);
    const bad = await caught(m.getMrDiffVersionFiles(REF, 42, 0));
    expect(bad.code).toBe('validation_error');
    expect(m.callsOf('mr_version')).toHaveLength(3);
  });
});
