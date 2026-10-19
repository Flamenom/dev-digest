/**
 * gitlab.com HTTP transport (plan T3): retry/backoff policy, Retry-After,
 * redirect refusal, timeout, token header placement and redaction.
 * Hermetic — injected fake fetch + fake sleep, no network.
 */
import { describe, it, expect } from 'vitest';
import { GitLabHttp, GitLabHttpError, parseRetryAfter } from '../src/adapters/gitlab/http.js';
import { fakeFetch, fakeSleep, json } from './fixtures/gitlab/fake-fetch.js';

const TOKEN = 'glpat-SECRET';

async function caught(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a rejection');
}

describe('GitLabHttp — retry policy', () => {
  it('429 with Retry-After: 2 sleeps 2 s once and then succeeds', async () => {
    let n = 0;
    const { fetch, calls } = fakeFetch(() =>
      ++n === 1 ? json({ message: 'Too Many Requests' }, 429, { 'retry-after': '2' }) : json({ id: 1 }),
    );
    const { sleep, delays } = fakeSleep();
    const http = new GitLabHttp({ token: TOKEN, fetch, sleep });
    const res = await http.rest<{ id: number }>('/projects/1');
    expect(res.data).toEqual({ id: 1 });
    expect(delays).toEqual([2000]);
    expect(calls).toHaveLength(2);
  });

  it('5xx ×4 → 3 retries at 1/2/4 s ±20 % jitter, then throws', async () => {
    for (const r of [0, 0.5, 1, Math.random()]) {
      const { fetch, calls } = fakeFetch(() => json({ message: 'boom' }, 503));
      const { sleep, delays } = fakeSleep();
      const http = new GitLabHttp({ fetch, sleep, random: () => r });
      const err = await caught(http.rest('/projects/1'));
      expect(err).toBeInstanceOf(GitLabHttpError);
      expect((err as GitLabHttpError).upstreamStatus).toBe(503);
      expect(calls).toHaveLength(4);
      expect(delays).toHaveLength(3);
      [1000, 2000, 4000].forEach((base, i) => {
        expect(delays[i]).toBeGreaterThanOrEqual(base * 0.8);
        expect(delays[i]).toBeLessThanOrEqual(base * 1.2);
      });
    }
  });

  it('caps Retry-After at 30 s and the total extra wait at 60 s', async () => {
    const { fetch, calls } = fakeFetch(() => json({}, 429, { 'retry-after': '120' }));
    const { sleep, delays } = fakeSleep();
    const http = new GitLabHttp({ fetch, sleep });
    await caught(http.rest('/projects/1'));
    expect(delays).toEqual([30000, 30000]);
    expect(delays.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60000);
    expect(calls).toHaveLength(3);
  });

  it('does not retry 4xx other than 429', async () => {
    const { fetch, calls } = fakeFetch(() => json({ message: '404 Project Not Found' }, 404));
    const { sleep, delays } = fakeSleep();
    const err = await caught(new GitLabHttp({ fetch, sleep }).rest('/projects/x'));
    expect((err as GitLabHttpError).upstreamStatus).toBe(404);
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it('parses Retry-After seconds and HTTP-dates', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('garbage')).toBeNull();
    const now = Date.parse('2026-10-16T00:00:00Z');
    expect(parseRetryAfter('Fri, 16 Oct 2026 00:00:05 GMT', now)).toBe(5000);
  });
});

describe('GitLabHttp — transport safety', () => {
  it('a 302 to evil.example throws and is never followed', async () => {
    const { fetch, calls } = fakeFetch(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }),
    );
    const err = await caught(new GitLabHttp({ token: TOKEN, fetch, sleep: fakeSleep().sleep }).rest('/user'));
    expect(err).toBeInstanceOf(GitLabHttpError);
    expect(err.message).toContain('evil.example');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.redirect).toBe('manual');
  });

  it('always targets https://gitlab.com with a per-attempt timeout signal', async () => {
    const { fetch, calls } = fakeFetch(() => json([]));
    const http = new GitLabHttp({ fetch });
    await http.rest('//evil.example/x', { page: 2 });
    expect(calls[0]!.url.origin).toBe('https://gitlab.com');
    expect(calls[0]!.url.searchParams.get('page')).toBe('2');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps a timeout to a GitLabHttpError (status 0)', async () => {
    const fetch = async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    };
    const err = await caught(new GitLabHttp({ fetch }).rest('/user'));
    expect((err as GitLabHttpError).upstreamStatus).toBe(0);
    expect(err.message).toMatch(/timed out/);
  });

  it('sends PRIVATE-TOKEN (REST) / Bearer (GraphQL) only when a token exists', async () => {
    const { fetch, calls } = fakeFetch(() => json({ data: { ok: true } }));
    await new GitLabHttp({ fetch }).rest('/projects/1');
    await new GitLabHttp({ fetch }).graphql('query{a}', {});
    await new GitLabHttp({ token: TOKEN, fetch }).rest('/projects/1');
    await new GitLabHttp({ token: TOKEN, fetch }).graphql('query{a}', {});
    expect(calls[0]!.headers['private-token']).toBeUndefined();
    expect(calls[1]!.headers.authorization).toBeUndefined();
    expect(calls[2]!.headers['private-token']).toBe(TOKEN);
    expect(calls[3]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[3]!.url.pathname).toBe('/api/graphql');
  });

  it('throws on a GraphQL errors array', async () => {
    const { fetch } = fakeFetch(() => json({ data: null, errors: [{ message: 'Field x is invalid' }] }));
    const err = await caught(new GitLabHttp({ fetch }).graphql('query{x}', {}));
    expect(err.message).toContain('Field x is invalid');
  });

  it(`never puts the token in a thrown message`, async () => {
    const b64 = Buffer.from(`oauth2:${TOKEN}`).toString('base64');
    const responders: (() => Response | Promise<Response>)[] = [
      () => json({ error: 'invalid_token', error_description: `Token ${TOKEN} has expired.` }, 401),
      () => json({ message: `PRIVATE-TOKEN: ${TOKEN} rejected` }, 403),
      () => new Response(`upstream echoed ${TOKEN} and ${b64}`, { status: 500 }),
      () => new Response(null, { status: 301, headers: { location: `https://x:${TOKEN}@evil.example/` } }),
      () => json({ data: null, errors: [{ message: `bad token ${TOKEN}` }] }),
      () => new Response('not json', { status: 200 }),
      () => {
        throw new Error(`connect ECONNREFUSED with header ${TOKEN}`);
      },
    ];
    for (const respond of responders) {
      const { fetch } = fakeFetch(respond);
      const http = new GitLabHttp({ token: TOKEN, fetch, sleep: fakeSleep().sleep });
      const settled = await Promise.allSettled([http.rest('/user'), http.graphql('query{a}', {})]);
      const errors = settled.flatMap((r) => (r.status === 'rejected' ? [r.reason as Error] : []));
      // A GraphQL `errors` body is a valid REST 200 — every other responder fails both.
      expect(errors.length).toBeGreaterThanOrEqual(1);
      for (const err of errors) {
        expect(err.message).not.toContain(TOKEN);
        expect(err.message).not.toContain(b64);
        const detail = (err as GitLabHttpError).upstreamDetail ?? '';
        expect(detail).not.toContain(TOKEN);
      }
    }
  });
});
