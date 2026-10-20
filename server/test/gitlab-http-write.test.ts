/**
 * gitlab.com write transport (plan gitlab-comments T2): `post()` retries ONLY
 * 429 (AC-31), never a 5xx/timeout/network error; reads keep retrying 5xx;
 * auth-failure classification + `onAuthFailure` hook (AC-24/AC-29); writes keep
 * the origin pin, `redirect:'manual'` and token redaction (AC-30).
 * Hermetic — injected fake fetch + fake sleep, no network.
 */
import { describe, it, expect, vi } from 'vitest';
import { GitLabHttp, GitLabHttpError } from '../src/adapters/gitlab/http.js';
import { fakeFetch, fakeSleep, json } from './fixtures/gitlab/fake-fetch.js';

const TOKEN = 'glpat-WRITE-SECRET';

async function caught(p: Promise<unknown>): Promise<GitLabHttpError> {
  try {
    await p;
  } catch (err) {
    return err as GitLabHttpError;
  }
  throw new Error('expected a rejection');
}

describe('GitLabHttp.post — write retry policy (AC-31)', () => {
  it('429 (Retry-After: 0) → 201: exactly 2 POSTs and the created body is returned', async () => {
    let n = 0;
    const { fetch, calls } = fakeFetch(() =>
      ++n === 1 ? json({ message: '429 Too Many Requests' }, 429, { 'retry-after': '0' }) : json({ id: 7 }, 201),
    );
    const http = new GitLabHttp({ token: TOKEN, fetch, sleep: fakeSleep().sleep });
    const res = await http.post<{ id: number }>('/projects/1/merge_requests/2/discussions', { body: 'x' });
    expect(res.data).toEqual({ id: 7 });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.method === 'POST')).toBe(true);
  });

  it('429 respects the existing budget (caps at GITLAB_MAX_RETRIES)', async () => {
    const { fetch, calls } = fakeFetch(() => json({}, 429, { 'retry-after': '1' }));
    const { sleep, delays } = fakeSleep();
    const err = await caught(new GitLabHttp({ token: TOKEN, fetch, sleep }).post('/x', {}));
    expect(err.upstreamStatus).toBe(429);
    expect(calls).toHaveLength(4);
    expect(delays).toEqual([1000, 1000, 1000]);
  });

  it.each([500, 502, 503, 504])('%i → exactly 1 POST, no sleep', async (status) => {
    const { fetch, calls } = fakeFetch(() => json({ message: 'boom' }, status));
    const { sleep, delays } = fakeSleep();
    const err = await caught(new GitLabHttp({ token: TOKEN, fetch, sleep }).post('/x', { body: 'b' }));
    expect(err).toBeInstanceOf(GitLabHttpError);
    expect(err.upstreamStatus).toBe(status);
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it('a fetch rejecting with TimeoutError → exactly 1 POST, status 0', async () => {
    const fetch = vi.fn(async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    });
    const err = await caught(new GitLabHttp({ token: TOKEN, fetch, sleep: fakeSleep().sleep }).post('/x', {}));
    expect(err.upstreamStatus).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a network error → exactly 1 POST, status 0', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const err = await caught(new GitLabHttp({ token: TOKEN, fetch, sleep: fakeSleep().sleep }).post('/x', {}));
    expect(err.upstreamStatus).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('regression: a GET 503 → 200 is still retried', async () => {
    let n = 0;
    const { fetch, calls } = fakeFetch(() => (++n === 1 ? json({}, 503) : json({ ok: true })));
    const http = new GitLabHttp({ token: TOKEN, fetch, sleep: fakeSleep().sleep, random: () => 0.5 });
    const res = await http.rest<{ ok: boolean }>('/projects/1');
    expect(res.data).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('regression: GraphQL (a POST read) still retries 5xx', async () => {
    let n = 0;
    const { fetch, calls } = fakeFetch(() => (++n === 1 ? json({}, 502) : json({ data: { a: 1 } })));
    const http = new GitLabHttp({ token: TOKEN, fetch, sleep: fakeSleep().sleep, random: () => 0.5 });
    expect(await http.graphql('query{a}', {})).toEqual({ a: 1 });
    expect(calls).toHaveLength(2);
  });
});

describe('GitLabHttp.post — transport safety', () => {
  it('sends a JSON body + PRIVATE-TOKEN to https://gitlab.com/api/v4 with redirect:manual', async () => {
    const { fetch, calls } = fakeFetch(() => json({ id: 1 }, 201));
    await new GitLabHttp({ token: TOKEN, fetch }).post('/projects/a%2Fb/merge_requests/3/discussions', {
      body: 'hello',
    });
    const req = calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url.origin).toBe('https://gitlab.com');
    expect(req.url.pathname).toBe('/api/v4/projects/a%2Fb/merge_requests/3/discussions');
    expect(req.headers['private-token']).toBe(TOKEN);
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.init.redirect).toBe('manual');
    expect(req.body).toEqual({ body: 'hello' });
  });

  it('a crafted path cannot change the origin', async () => {
    const { fetch, calls } = fakeFetch(() => json({ id: 1 }, 201));
    await new GitLabHttp({ token: TOKEN, fetch }).post('//evil.example/x', {});
    expect(calls[0]!.url.origin).toBe('https://gitlab.com');
  });

  it('a 307 is never followed (1 request, error)', async () => {
    const { fetch, calls } = fakeFetch(
      () => new Response(null, { status: 307, headers: { location: 'https://evil.example/' } }),
    );
    const err = await caught(new GitLabHttp({ token: TOKEN, fetch }).post('/x', {}));
    expect(err.upstreamStatus).toBe(307);
    expect(calls).toHaveLength(1);
  });

  it('never puts the token in a write error message or detail', async () => {
    const responders: (() => Response)[] = [
      () => json({ message: `PRIVATE-TOKEN: ${TOKEN} rejected` }, 403),
      () => new Response(`echo ${TOKEN}`, { status: 502 }),
      () => json({ error: 'invalid_token', error_description: `Token ${TOKEN} revoked` }, 401),
    ];
    for (const respond of responders) {
      const { fetch } = fakeFetch(respond);
      const err = await caught(new GitLabHttp({ token: TOKEN, fetch }).post('/x', { body: TOKEN }));
      expect(err.message).not.toContain(TOKEN);
      expect(err.upstreamDetail ?? '').not.toContain(TOKEN);
    }
  });
});

describe('GitLabHttp — auth failure classification (AC-24/AC-29)', () => {
  it('403 with WWW-Authenticate insufficient_scope → authFailure + onAuthFailure once', async () => {
    const onAuthFailure = vi.fn();
    const { fetch } = fakeFetch(() =>
      json({ error: 'insufficient_scope' }, 403, {
        'www-authenticate': 'Bearer realm="", error="insufficient_scope", error_description="needs api"',
      }),
    );
    const err = await caught(new GitLabHttp({ token: TOKEN, fetch, onAuthFailure }).post('/x', {}));
    expect(err.authFailure).toBe('insufficient_scope');
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    expect(onAuthFailure).toHaveBeenCalledWith('insufficient_scope');
  });

  it('403 with JSON error insufficient_scope (no header) → insufficient_scope', async () => {
    const onAuthFailure = vi.fn();
    const { fetch } = fakeFetch(() => json({ error: 'insufficient_scope' }, 403));
    const err = await caught(new GitLabHttp({ token: TOKEN, fetch, onAuthFailure }).rest('/x'));
    expect(err.authFailure).toBe('insufficient_scope');
    expect(onAuthFailure).toHaveBeenCalledWith('insufficient_scope');
  });

  it('401 → invalid (reads and writes)', async () => {
    const onAuthFailure = vi.fn();
    const { fetch } = fakeFetch(() => json({ message: '401 Unauthorized' }, 401));
    const http = new GitLabHttp({ token: TOKEN, fetch, onAuthFailure });
    expect((await caught(http.rest('/x'))).authFailure).toBe('invalid');
    expect((await caught(http.post('/x', {}))).authFailure).toBe('invalid');
    expect(onAuthFailure.mock.calls).toEqual([['invalid'], ['invalid']]);
  });

  it('a plain 403 (locked discussion) / 404 / 5xx is not an auth failure', async () => {
    const onAuthFailure = vi.fn();
    for (const status of [403, 404, 500]) {
      const { fetch } = fakeFetch(() => json({ message: 'nope' }, status));
      const err = await caught(new GitLabHttp({ token: TOKEN, fetch, onAuthFailure }).post('/x', {}));
      expect(err.authFailure).toBeNull();
    }
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  it('a throwing hook never masks the request error', async () => {
    const { fetch } = fakeFetch(() => json({}, 401));
    const err = await caught(
      new GitLabHttp({
        token: TOKEN,
        fetch,
        onAuthFailure: () => {
          throw new Error('hook boom');
        },
      }).rest('/x'),
    );
    expect(err).toBeInstanceOf(GitLabHttpError);
    expect(err.upstreamStatus).toBe(401);
  });
});
