/**
 * gitlab.com transport additions for publish findings (plan gitlab-publish-findings
 * T3): `delete()` is idempotent (read policy — 5xx retried, 404 surfaced, no
 * body parse); `post()` charges 429 waits to a shared per-publication
 * `WaitBudget` (AC-28) while `GITLAB_MAX_RETRIES` still caps attempts (Q8);
 * `post()` tolerates a 204 / empty body. Hermetic — fake fetch + fake sleep.
 */
import { describe, it, expect, vi } from 'vitest';
import type { WaitBudget } from '@devdigest/shared';
import { GitLabHttp, GitLabHttpError } from '../src/adapters/gitlab/http.js';
import { fakeFetch, fakeSleep, json } from './fixtures/gitlab/fake-fetch.js';

const TOKEN = 'glpat-DELETE-BUDGET-SECRET';

async function caught(p: Promise<unknown>): Promise<GitLabHttpError> {
  try {
    await p;
  } catch (err) {
    return err as GitLabHttpError;
  }
  throw new Error('expected a rejection');
}

describe('GitLabHttp.delete — idempotent read policy', () => {
  it('204 → resolves without parsing a body; token header + manual redirect + DELETE', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const res = await new GitLabHttp({ token: TOKEN, fetch, sleep: fakeSleep().sleep }).delete('/projects/1/x/9');
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.headers['private-token']).toBe(TOKEN);
    expect(calls[0]!.init.redirect).toBe('manual');
    expect(calls[0]!.url.origin).toBe('https://gitlab.com');
  });

  it('503 → 204 is retried (idempotent)', async () => {
    let n = 0;
    const { fetch, calls } = fakeFetch(() => (++n === 1 ? json({}, 503) : new Response(null, { status: 204 })));
    const http = new GitLabHttp({ token: TOKEN, fetch, sleep: fakeSleep().sleep, random: () => 0.5 });
    expect((await http.delete('/x')).status).toBe(204);
    expect(calls).toHaveLength(2);
  });

  it('404 is surfaced (not retried) so the caller can treat it as already gone', async () => {
    const { fetch, calls } = fakeFetch(() => json({ message: '404 Not found' }, 404));
    const err = await caught(new GitLabHttp({ token: TOKEN, fetch, sleep: fakeSleep().sleep }).delete('/x'));
    expect(err.upstreamStatus).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it('a network error is never retried, and the message never carries the token', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError(`connect failed for ${TOKEN}`);
    });
    const err = await caught(new GitLabHttp({ token: TOKEN, fetch, sleep: fakeSleep().sleep }).delete('/x'));
    expect(err.upstreamStatus).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(err.message).not.toContain(TOKEN);
  });
});

describe('GitLabHttp.post — shared wait budget (AC-28, Q8)', () => {
  it('429 (Retry-After: 1) → 201: 2 POSTs and the budget is reduced by 1000 ms', async () => {
    let n = 0;
    const { fetch, calls } = fakeFetch(() =>
      ++n === 1 ? json({}, 429, { 'retry-after': '1' }) : json({ id: 3, note: 'n' }, 201),
    );
    const { sleep, delays } = fakeSleep();
    const budget: WaitBudget = { remainingMs: 60_000 };
    const res = await new GitLabHttp({ token: TOKEN, fetch, sleep }).post('/x', {}, { waitBudget: budget });
    expect(res.data).toEqual({ id: 3, note: 'n' });
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([1000]);
    expect(budget.remainingMs).toBe(59_000);
  });

  it('one budget shared by two writes: the second exhausts it and surfaces the 429', async () => {
    const { fetch, calls } = fakeFetch(() => json({}, 429, { 'retry-after': '1' }));
    const { sleep, delays } = fakeSleep();
    const budget: WaitBudget = { remainingMs: 1500 };
    const http = new GitLabHttp({ token: TOKEN, fetch, sleep });

    let err = await caught(http.post('/a', {}, { waitBudget: budget }));
    expect(err.upstreamStatus).toBe(429);
    // 1000 ms, then 500 ms (the rest of the budget), then budget 0 ⇒ surfaced.
    expect(delays).toEqual([1000, 500]);
    expect(budget.remainingMs).toBe(0);
    expect(calls).toHaveLength(3);

    err = await caught(http.post('/b', {}, { waitBudget: budget }));
    expect(err.upstreamStatus).toBe(429);
    expect(calls).toHaveLength(4); // exactly one more POST, no wait
    expect(delays).toEqual([1000, 500]);
  });

  it('a persistent 429 with Retry-After: 0 still stops at GITLAB_MAX_RETRIES (4 POSTs)', async () => {
    const { fetch, calls } = fakeFetch(() => json({}, 429, { 'retry-after': '0' }));
    const budget: WaitBudget = { remainingMs: 60_000 };
    const err = await caught(
      new GitLabHttp({ token: TOKEN, fetch, sleep: fakeSleep().sleep }).post('/x', {}, { waitBudget: budget }),
    );
    expect(err.upstreamStatus).toBe(429);
    expect(calls).toHaveLength(4);
    expect(budget.remainingMs).toBe(60_000);
  });

  it('a 5xx is never charged to the budget nor re-sent', async () => {
    const { fetch, calls } = fakeFetch(() => json({}, 502));
    const budget: WaitBudget = { remainingMs: 60_000 };
    const err = await caught(
      new GitLabHttp({ token: TOKEN, fetch, sleep: fakeSleep().sleep }).post('/x', {}, { waitBudget: budget }),
    );
    expect(err.upstreamStatus).toBe(502);
    expect(calls).toHaveLength(1);
    expect(budget.remainingMs).toBe(60_000);
  });

  it('a 204 / empty 2xx body → data null (no non-JSON error)', async () => {
    let { fetch } = fakeFetch(() => new Response(null, { status: 204 }));
    expect((await new GitLabHttp({ token: TOKEN, fetch }).post('/x', {})).data).toBeNull();
    ({ fetch } = fakeFetch(() => new Response('', { status: 201 })));
    expect((await new GitLabHttp({ token: TOKEN, fetch }).post('/x', {})).data).toBeNull();
    ({ fetch } = fakeFetch(() => new Response('<html>', { status: 201 })));
    const err = await caught(new GitLabHttp({ token: TOKEN, fetch }).post('/x', {}));
    expect(err.upstreamStatus).toBe(201);
  });
});
