import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MockGitHubClient } from '../src/adapters/mocks.js';
import {
  anonymous,
  asSession,
  buildHermeticGoogleApp,
  recording,
  type HermeticGoogleApp,
} from './helpers/google-mode.js';

/**
 * NFR "fail closed": an error while resolving the caller denies the request —
 * it never falls through to an anonymous or system-user context, no handler
 * runs, and the internal error message is not echoed to the client.
 */
describe('fail closed (google mode)', () => {
  let t: HermeticGoogleApp;
  const repoService = recording('repoService');
  const github = recording('github', new MockGitHubClient({ login: 'octocat' }));
  const handlerCalls: string[] = [];
  const logs: string[] = [];

  beforeAll(async () => {
    t = await buildHermeticGoogleApp({
      recordDb: true,
      logStream: { write: (line) => void logs.push(line) },
      overrides: { repoService: repoService.value as never, github: github.value },
      beforeReady: (app) => {
        app.get('/zz-fail-probe', async () => (handlerCalls.push('probe'), { ok: true }));
      },
    });
    repoService.reset();
    t.principals.failWith(new Error('connection to db-internal.svc:5432 refused'));
  });
  afterAll(async () => {
    await t?.close();
  });

  it('a throwing principal resolver → non-2xx, handler not called, no internals leaked', async () => {
    const cred = t.principals.session('admin');
    for (const req of [
      { method: 'GET' as const, url: '/repos' },
      { method: 'GET' as const, url: '/zz-fail-probe' },
      { method: 'POST' as const, url: '/settings/test-connection', payload: { provider: 'github' } },
    ]) {
      const res = await t.app.inject(asSession(cred, req));
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).not.toBe(404);
      expect(res.json().error.code).toBe('auth_unavailable');
      expect(res.body).not.toContain('db-internal');
    }
    const anon = await t.app.inject(anonymous({ method: 'GET', url: '/repos' }));
    expect(anon.statusCode).toBe(503);

    expect(handlerCalls).toEqual([]);
    expect(repoService.calls).toEqual([]);
    expect(github.calls).toEqual([]);
    expect(t.dbLog?.calls).toEqual([]);
  });

  it('logs the failure without credentials', () => {
    const joined = logs.join('\n');
    expect(joined).toContain('principal resolution failed');
    expect(joined).not.toContain('__Host-ddg_session=');
  });

  it('public routes that do not need a principal keep working', async () => {
    const res = await t.app.inject(anonymous({ method: 'GET', url: '/health' }));
    expect(res.statusCode).toBe(200);
  });

  it('an unexpected sign-in callback error → redirect to /sign-in, and no log line carries code / state', async () => {
    const code = 'oauth-code-must-not-be-logged-4f1c';
    const state = 'oauth-state-must-not-be-logged-9b2e';
    logs.length = 0;
    // The recording DB throws on use → `container.signIn()` fails unexpectedly
    // (not an AuthFlowError).
    const res = await t.app.inject(
      anonymous({ method: 'GET', url: `/auth/google/callback?code=${code}&state=${state}` }),
    );
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${t.config.publicOrigin}/sign-in?error=auth_idp_unavailable`);
    expect(res.body).not.toContain(code);

    // Any other route: the request log line's URL has the values redacted.
    await t.app.inject(anonymous({ method: 'GET', url: `/health?code=${code}&state=${state}&keep=1` }));

    const joined = logs.join('\n');
    expect(joined).toContain('sign-in callback failed unexpectedly');
    expect(joined).toContain('keep=1');
    expect(joined).toContain('code=%5BREDACTED%5D');
    expect(joined).not.toContain(code);
    expect(joined).not.toContain(state);
  });
});
