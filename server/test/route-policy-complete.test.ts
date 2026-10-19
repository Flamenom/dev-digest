import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { registeredRouteKeys } from '../src/platform/auth/guard.js';
import { ROUTE_POLICY } from '../src/platform/auth/route-policy.js';
import { anonymous, buildHermeticGoogleApp, type HermeticGoogleApp } from './helpers/google-mode.js';

/**
 * T22 — the route table and the Permission matrix are the SAME set (hermetic).
 *
 * `auth-guard-matrix.test.ts` already proves "every registered route is
 * classified" (registered ⊆ policy, with identity stand-ins). This file
 * extends it with the real identity module registered:
 *  - the reverse direction: every policy entry is a real route (no stale or
 *    misspelled keys that would silently classify nothing);
 *  - AC-63: no test / dev-login / impersonation route exists in google mode;
 *  - local mode registers exactly the same routes (one route table, AC-2).
 */

const TEST_ONLY_ROUTE = /\/(test|dev-login|impersonate)(\/|$)|\/__/i;

const policyKeys = () => Object.keys(ROUTE_POLICY).sort();

describe('route policy completeness (T22, AC-28, AC-63)', () => {
  let google: HermeticGoogleApp | undefined;

  afterAll(async () => {
    await google?.close();
  });

  it('google mode: registered routes == policy keys, and no test-only sign-in route', async () => {
    google = await buildHermeticGoogleApp();
    const keys = registeredRouteKeys(google.app);

    const unclassified = keys.filter((k) => !Object.prototype.hasOwnProperty.call(ROUTE_POLICY, k));
    const stale = policyKeys().filter((k) => !keys.includes(k));
    expect({ unclassified, stale }).toEqual({ unclassified: [], stale: [] });

    expect(keys.filter((k) => TEST_ONLY_ROUTE.test(k.split(' ')[1]!))).toEqual([]);
    // The identity module (plan Q6) is the real implementation, not a stand-in.
    for (const key of [
      'GET /auth/google/start',
      'GET /auth/google/callback',
      'GET /auth/session',
      'POST /auth/sign-out',
      'GET /members',
      'PATCH /members/:userId',
      'GET /tokens',
      'POST /tokens',
      'DELETE /tokens/:id',
    ]) {
      expect(keys).toContain(key);
    }
  });

  it('google mode: a guessed dev-login path is not routable', async () => {
    google ??= await buildHermeticGoogleApp();
    for (const url of ['/auth/dev-login', '/auth/test', '/auth/impersonate', '/dev-login']) {
      const res = await google.app.inject(anonymous({ method: 'POST', url }));
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('local mode registers the same route table', async () => {
    const config = loadConfig({ ...process.env, NODE_ENV: 'test', AUTH_MODE: 'local' } as NodeJS.ProcessEnv);
    const app = await buildApp({ config });
    try {
      await app.ready();
      expect(registeredRouteKeys(app)).toEqual(policyKeys());
    } finally {
      await app.close();
    }
  });
});
