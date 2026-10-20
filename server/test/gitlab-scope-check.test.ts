/**
 * RestGitLabClient.checkTokenScopes (plan gitlab-comments T2; AC-21/22/24/28):
 * `GET /user` then `GET /personal_access_tokens/self`; `api` is mandatory; a
 * definitive non-answer ⇒ insufficient_scope; a transient failure ⇒ unverified.
 * Hermetic fake fetch.
 */
import { describe, it, expect } from 'vitest';
import { RestGitLabClient } from '../src/adapters/gitlab/client.js';
import { MockGitLabClient } from '../src/adapters/mocks.js';
import { fakeFetch, fakeSleep, json, type FakeRequest } from './fixtures/gitlab/fake-fetch.js';

const TOKEN = 'glpat-SCOPE-SECRET';
const path = (r: FakeRequest) => r.url.pathname.replace('/api/v4', '');

function probe(selfResponse: () => Response, userResponse: () => Response = () => json({ username: 'bot' })) {
  const { fetch, calls } = fakeFetch((req) => (path(req) === '/user' ? userResponse() : selfResponse()));
  const c = new RestGitLabClient({ token: TOKEN, fetch, sleep: fakeSleep().sleep, random: () => 0.5 });
  return { c, calls };
}

describe('checkTokenScopes', () => {
  it("['api'] → ok with username and scopes (AC-22)", async () => {
    const { c, calls } = probe(() => json({ scopes: ['api', 'read_repository'] }));
    expect(await c.checkTokenScopes()).toEqual({
      kind: 'ok',
      username: 'bot',
      scopes: ['api', 'read_repository'],
    });
    expect(calls.map(path)).toEqual(['/user', '/personal_access_tokens/self']);
  });

  it("['read_api','read_repository'] → insufficient_scope (AC-21)", async () => {
    const { c } = probe(() => json({ scopes: ['read_api', 'read_repository'] }));
    expect(await c.checkTokenScopes()).toEqual({ kind: 'insufficient_scope', username: 'bot' });
  });

  it('self 404 / 403 / no scopes list → insufficient_scope (definitive non-answer, AC-28)', async () => {
    for (const respond of [
      () => json({ message: '404 Not Found' }, 404),
      () => json({ message: '403 Forbidden' }, 403),
      () => json({ id: 1 }),
    ]) {
      const { c } = probe(respond);
      expect(await c.checkTokenScopes()).toEqual({ kind: 'insufficient_scope', username: 'bot' });
    }
  });

  it('self 503 / 429 / timeout → unverified (transient, AC-28)', async () => {
    const responders: (() => Response)[] = [
      () => json({}, 503),
      () => json({}, 429, { 'retry-after': '0' }),
      () => {
        throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      },
    ];
    for (const respond of responders) {
      const { c } = probe(respond);
      expect(await c.checkTokenScopes()).toEqual({ kind: 'unverified' });
    }
  });

  it('/user 401 → invalid with reason; 0 scope requests (AC-29)', async () => {
    const { c, calls } = probe(
      () => json({ scopes: ['api'] }),
      () => json({ error: 'invalid_token', error_description: 'Token is expired' }, 401),
    );
    expect(await c.checkTokenScopes()).toEqual({ kind: 'invalid', reason: 'expired' });
    expect(calls.map(path)).toEqual(['/user']);
  });

  it('/user 503 → unverified', async () => {
    const { c } = probe(
      () => json({ scopes: ['api'] }),
      () => json({}, 503),
    );
    expect(await c.checkTokenScopes()).toEqual({ kind: 'unverified' });
  });

  it('/user 403 insufficient_scope → insufficient_scope (username unknown)', async () => {
    const { c } = probe(
      () => json({ scopes: ['api'] }),
      () => json({ error: 'insufficient_scope' }, 403, { 'www-authenticate': 'Bearer error="insufficient_scope"' }),
    );
    expect(await c.checkTokenScopes()).toEqual({ kind: 'insufficient_scope', username: null });
  });

  it('no token → invalid without any request', async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    const c = new RestGitLabClient({ token: null, fetch });
    expect(await c.checkTokenScopes()).toEqual({ kind: 'invalid', reason: 'invalid' });
    expect(calls).toHaveLength(0);
  });

  it('checkToken() (frozen GitLabClient port) is unchanged: read_api token still ok:true', async () => {
    const { c } = probe(() => json({ scopes: ['read_api', 'read_repository'] }));
    expect(await c.checkToken()).toEqual({
      ok: true,
      username: 'bot',
      scopes: ['read_api', 'read_repository'],
      missingScopes: [],
    });
  });
});

describe('MockGitLabClient.checkTokenScopes', () => {
  it('defaults to ok devdigest-bot/api and records user + token_scopes', async () => {
    const m = new MockGitLabClient();
    expect(await m.checkTokenScopes()).toEqual({ kind: 'ok', username: 'devdigest-bot', scopes: ['api'] });
    expect(m.calls.map((c) => c.kind)).toEqual(['user', 'token_scopes']);
  });

  it('is configurable', async () => {
    const m = new MockGitLabClient({ scopeCheck: { kind: 'insufficient_scope', username: 'old' } });
    expect(await m.checkTokenScopes()).toEqual({ kind: 'insufficient_scope', username: 'old' });
  });
});
