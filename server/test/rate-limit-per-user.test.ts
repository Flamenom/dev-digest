import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MockGitHubClient } from '../src/adapters/mocks.js';
import { DEFAULT_REJECTION_LIMIT, RejectionLimiter } from '../src/platform/auth/guard.js';
import {
  anonymous,
  asSession,
  buildHermeticGoogleApp,
  type HermeticGoogleApp,
} from './helpers/google-mode.js';

/**
 * AC-53 — google mode keys rate limits per USER (a team behind one NAT
 * address doesn't share a budget); sign-in start + callback are limited to
 * 20/min per IP; existing per-route limits apply per user.
 *
 * Every request comes from the same inject address (127.0.0.1). The sign-in
 * routes are T22's: until they exist, stand-ins are registered at the same
 * URLs (the per-IP limit is applied from the policy table, not the route).
 */

const SIGN_IN_ROUTES = ['/auth/google/start', '/auth/google/callback'] as const;

describe('per-user rate limits (google mode)', () => {
  let t: HermeticGoogleApp;

  beforeAll(async () => {
    t = await buildHermeticGoogleApp({
      rateLimit: true,
      overrides: { github: new MockGitHubClient({ login: 'octocat' }) },
      beforeReady: (app) => {
        app.get('/zz-rate-probe', async () => ({ ok: true }));
        for (const url of SIGN_IN_ROUTES) {
          if (!app.hasRoute({ method: 'GET', url })) app.get(url, async () => ({ ok: true }));
        }
      },
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('two users from one IP each make 120 req/min without a 429; the 121st of one user is limited', async () => {
    const a = t.principals.session('admin');
    const b = t.principals.session('admin');
    for (let i = 0; i < 120; i++) {
      const [ra, rb] = await Promise.all([
        t.app.inject(asSession(a, { method: 'GET', url: '/zz-rate-probe' })),
        t.app.inject(asSession(b, { method: 'GET', url: '/zz-rate-probe' })),
      ]);
      expect(ra.statusCode).toBe(200);
      expect(rb.statusCode).toBe(200);
    }
    const over = await t.app.inject(asSession(a, { method: 'GET', url: '/zz-rate-probe' }));
    expect(over.statusCode).toBe(429);
    // A third user on the same IP still has a full budget.
    const c = t.principals.session('member');
    const fresh = await t.app.inject(asSession(c, { method: 'GET', url: '/repos' }));
    expect(fresh.statusCode).not.toBe(429);
  });

  it.each(SIGN_IN_ROUTES)('%s: 20/min per IP — the 21st from one IP is 429, another IP is unaffected', async (url) => {
    for (let i = 0; i < 20; i++) {
      const res = await t.app.inject(anonymous({ method: 'GET', url }));
      expect(res.statusCode).not.toBe(429);
    }
    const blocked = await t.app.inject(anonymous({ method: 'GET', url }));
    expect(blocked.statusCode).toBe(429);
    // Forwarded client IP is trusted from the proxy (TRUST_PROXY=127.0.0.1).
    const other = await t.app.inject(
      anonymous({ method: 'GET', url, headers: { 'x-forwarded-for': '203.0.113.7' } }),
    );
    expect(other.statusCode).not.toBe(429);
  });

  it('an existing per-route limit (test-connection 20/min) applies per user', async () => {
    const a = t.principals.session('admin');
    const b = t.principals.session('admin');
    const call = (who: typeof a) =>
      t.app.inject(
        asSession(who, { method: 'POST', url: '/settings/test-connection', payload: { provider: 'github' } }),
      );
    for (let i = 0; i < 20; i++) {
      const [ra, rb] = await Promise.all([call(a), call(b)]);
      expect(ra.statusCode).toBe(200);
      expect(rb.statusCode).toBe(200);
    }
    expect((await call(a)).statusCode).toBe(429);
  });

  it('rejected requests (bad bearer / cookie) count per IP: over budget → 429 before any principal lookup', async () => {
    const ip = '198.51.100.23';
    const bad = (i: number) =>
      t.app.inject(
        i % 2 === 0
          ? { method: 'GET', url: '/repos', headers: { authorization: `Bearer ddg_pat_guess${i}`, 'x-forwarded-for': ip } }
          : { method: 'GET', url: '/repos', headers: { cookie: `__Host-ddg_session=guess${i}`, 'x-forwarded-for': ip } },
      );
    for (let i = 0; i < DEFAULT_REJECTION_LIMIT.max; i++) {
      expect((await bad(i)).statusCode).toBe(401);
    }
    const lookupsBefore = t.principals.calls;
    const blocked = await bad(DEFAULT_REJECTION_LIMIT.max);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('rate_limited');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(t.principals.calls).toBe(lookupsBefore); // no lookup once blocked

    // Another address is unaffected; so is a valid credential from yet another IP.
    const other = await t.app.inject({
      method: 'GET',
      url: '/repos',
      headers: { authorization: 'Bearer ddg_pat_nope', 'x-forwarded-for': '198.51.100.24' },
    });
    expect(other.statusCode).toBe(401);
  });
});

describe('RejectionLimiter', () => {
  it('blocks an address after `max` rejections until the window resets', () => {
    let now = 1_000_000;
    const limiter = new RejectionLimiter({ max: 3, windowMs: 60_000 }, () => now);
    for (let i = 0; i < 3; i++) {
      expect(limiter.blockedFor('a')).toBeNull();
      limiter.hit('a');
    }
    expect(limiter.blockedFor('a')).toBe(60);
    expect(limiter.blockedFor('b')).toBeNull();
    now += 60_000;
    expect(limiter.blockedFor('a')).toBeNull();
    limiter.hit('a');
    expect(limiter.blockedFor('a')).toBeNull();
  });
});
