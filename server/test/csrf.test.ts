import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MockGitHubClient } from '../src/adapters/mocks.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { passesCsrf, requestOrigin } from '../src/platform/auth/csrf.js';
import {
  asSession,
  asToken,
  buildHermeticGoogleApp,
  HERMETIC_DATABASE_URL,
  TEST_ORIGIN,
  type HermeticGoogleApp,
} from './helpers/google-mode.js';

/**
 * AC-50 — cookie-authenticated mutations need the exact public Origin (or
 * Referer origin) AND the `x-devdigest-csrf` header; bearer tokens are exempt.
 * AC-2 — local mode has no CSRF check at all.
 */

const TEST_CONNECTION = {
  method: 'POST' as const,
  url: '/settings/test-connection',
  payload: { provider: 'github' },
};

describe('passesCsrf (pure)', () => {
  it('only checks mutating methods', () => {
    expect(passesCsrf('GET', {}, TEST_ORIGIN)).toBe(true);
    expect(passesCsrf('HEAD', {}, TEST_ORIGIN)).toBe(true);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(passesCsrf(m, {}, TEST_ORIGIN)).toBe(false);
  });

  it('requires an exact origin match and the custom header', () => {
    const ok = { origin: TEST_ORIGIN, 'x-devdigest-csrf': '1' };
    expect(passesCsrf('POST', ok, TEST_ORIGIN)).toBe(true);
    expect(passesCsrf('POST', { ...ok, origin: `${TEST_ORIGIN}.evil.io` }, TEST_ORIGIN)).toBe(false);
    expect(passesCsrf('POST', { ...ok, origin: 'http://devdigest.test' }, TEST_ORIGIN)).toBe(false);
    expect(passesCsrf('POST', { ...ok, origin: 'null' }, TEST_ORIGIN)).toBe(false);
    expect(passesCsrf('POST', { origin: TEST_ORIGIN }, TEST_ORIGIN)).toBe(false);
    expect(passesCsrf('POST', { ...ok, 'x-devdigest-csrf': '' }, TEST_ORIGIN)).toBe(false);
    expect(passesCsrf('POST', { ...ok, 'x-devdigest-csrf': ['1', '1'] }, TEST_ORIGIN)).toBe(false);
  });

  it('falls back to the Referer origin only when Origin is absent', () => {
    expect(requestOrigin({ referer: `${TEST_ORIGIN}/settings?x=1` })).toBe(TEST_ORIGIN);
    expect(requestOrigin({ origin: 'https://a.example', referer: `${TEST_ORIGIN}/x` })).toBe('https://a.example');
    expect(requestOrigin({ referer: 'not a url' })).toBeUndefined();
    expect(requestOrigin({})).toBeUndefined();
  });
});

describe('CSRF over HTTP (google mode)', () => {
  let t: HermeticGoogleApp;
  const github = new MockGitHubClient({ login: 'octocat' });

  beforeAll(async () => {
    t = await buildHermeticGoogleApp({
      overrides: { github },
      beforeReady: (app) => {
        // Unclassified → Admin; a GET probe that needs no DB.
        app.get('/zz-csrf-probe', async () => ({ ok: true }));
      },
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('cross-site form POST with a valid cookie (no Origin match, no header) → 403 csrf_rejected', async () => {
    const admin = t.principals.session('admin');
    const res = await t.app.inject(
      asSession(admin, TEST_CONNECTION, { origin: 'https://evil.example', csrf: false }),
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf_rejected');
  });

  it('correct Origin but missing header → 403; header but foreign Origin → 403; neither Origin nor Referer → 403', async () => {
    const admin = t.principals.session('admin');
    const noHeader = await t.app.inject(asSession(admin, TEST_CONNECTION, { csrf: false }));
    expect(noHeader.json().error.code).toBe('csrf_rejected');
    const foreign = await t.app.inject(asSession(admin, TEST_CONNECTION, { origin: 'https://evil.example' }));
    expect(foreign.json().error.code).toBe('csrf_rejected');
    const none = await t.app.inject(asSession(admin, TEST_CONNECTION, { origin: null }));
    expect(none.json().error.code).toBe('csrf_rejected');
  });

  it('same request from the web origin with the header → 200', async () => {
    const admin = t.principals.session('admin');
    const res = await t.app.inject(asSession(admin, TEST_CONNECTION));
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('Referer fallback: matching Referer origin passes, a foreign one is rejected', async () => {
    const admin = t.principals.session('admin');
    const ok = await t.app.inject(
      asSession(admin, { ...TEST_CONNECTION, headers: { referer: `${TEST_ORIGIN}/settings` } }, { origin: null }),
    );
    expect(ok.statusCode).toBe(200);
    const bad = await t.app.inject(
      asSession(admin, { ...TEST_CONNECTION, headers: { referer: 'https://evil.example/x' } }, { origin: null }),
    );
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error.code).toBe('csrf_rejected');
  });

  it('bearer-token POST without Origin or header → 200 (exempt)', async () => {
    const admin = t.principals.token('admin');
    const res = await t.app.inject(asToken(admin, TEST_CONNECTION));
    expect(res.statusCode).toBe(200);
  });

  it('safe methods are not CSRF-checked', async () => {
    const admin = t.principals.session('admin');
    const res = await t.app.inject(
      asSession(admin, { method: 'GET', url: '/zz-csrf-probe' }, { origin: null, csrf: false }),
    );
    expect(res.statusCode).toBe(200);
  });

  it('an unauthenticated mutation is 401 (auth is checked before CSRF)', async () => {
    const res = await t.app.inject({ ...TEST_CONNECTION, headers: { origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('local mode (AC-2)', () => {
  it('no CSRF header or Origin required', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: HERMETIC_DATABASE_URL,
    } as NodeJS.ProcessEnv);
    expect(config.authMode).toBe('local');
    const app = await buildApp({ config, overrides: { github: new MockGitHubClient({ login: 'octocat' }) } });
    try {
      const res = await app.inject(TEST_CONNECTION);
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    } finally {
      await app.close();
    }
  });
});
