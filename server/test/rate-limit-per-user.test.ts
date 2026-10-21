import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MockAuthProvider, MockGitHubClient, MockIdentityProvider } from '../src/adapters/mocks.js';
import { DEFAULT_REJECTION_LIMIT, RejectionLimiter, rejectionKey } from '../src/platform/auth/guard.js';
import {
  anonymous,
  asSession,
  asToken,
  buildHermeticGoogleApp,
  FAKE_WORKSPACE_ID,
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
 *
 * Hermetic + fast: the real sign-in handlers resolve the team workspace and
 * persist/consume OAuth flows. Against the unreachable hermetic DB URL each
 * of those took ~1.7 s (postgres-js connect attempts), so 21 sign-in requests
 * could outlive the 60 s `timeWindow` under full-suite load and the 21st was
 * never a 429. Here the team workspace comes from `MockAuthProvider`, the IdP
 * is `MockIdentityProvider`, audit is an in-memory no-op and the DB is the
 * recording proxy, which rejects synchronously — every request is ~ms, so
 * the whole window-bound burst finishes far inside one window.
 */

const SIGN_IN_ROUTES = ['/auth/google/start', '/auth/google/callback'] as const;

describe('per-user rate limits (google mode)', () => {
  let t: HermeticGoogleApp;

  beforeAll(async () => {
    t = await buildHermeticGoogleApp({
      rateLimit: true,
      recordDb: true,
      overrides: {
        github: new MockGitHubClient({ login: 'octocat' }),
        auth: new MockAuthProvider(undefined, { id: FAKE_WORKSPACE_ID, name: 'default' }),
        identityProvider: new MockIdentityProvider(),
        audit: { record: async () => {} },
      },
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

  it('the real sign-in callback answers without touching the DB or the network (hermetic setup)', async () => {
    t.dbLog?.reset();
    const res = await t.app.inject(
      anonymous({ method: 'GET', url: '/auth/google/callback', headers: { 'x-forwarded-for': '192.0.2.99' } }),
    );
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error=auth_state_invalid');
    expect(t.dbLog?.calls).toEqual([]);
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

  it.each(SIGN_IN_ROUTES)(
    '%s: IPv6 rotation inside one /64 shares the per-IP budget; another /64 is unaffected',
    async (url) => {
      // 20 starts, each from a different address in 2001:db8:5:<n>::/64.
      const p = url.endsWith('start') ? '2001:db8:5:1' : '2001:db8:5:3';
      for (let i = 0; i < 20; i++) {
        const res = await t.app.inject(
          anonymous({ method: 'GET', url, headers: { 'x-forwarded-for': `${p}:${(i + 1).toString(16)}::${i + 7}` } }),
        );
        expect(res.statusCode).not.toBe(429);
      }
      const blocked = await t.app.inject(
        anonymous({ method: 'GET', url, headers: { 'x-forwarded-for': `${p}:dead:beef:0:21` } }),
      );
      expect(blocked.statusCode).toBe(429);
      // A different /64 is a separate bucket.
      const otherNet = url.endsWith('start') ? '2001:db8:5:2::1' : '2001:db8:5:4::1';
      const other = await t.app.inject(anonymous({ method: 'GET', url, headers: { 'x-forwarded-for': otherNet } }));
      expect(other.statusCode).not.toBe(429);
    },
  );

  it('anonymous global limit: requests rotating within one /64 share a bucket; another /64 does not', async () => {
    // `/auth/session` is public, so anonymous requests reach the global 120/min limiter.
    const call = (ip: string) =>
      t.app.inject(anonymous({ method: 'GET', url: '/auth/session', headers: { 'x-forwarded-for': ip } }));
    for (let i = 0; i < 120; i++) {
      expect((await call(`2001:db8:77:1:${(i + 1).toString(16)}::1`)).statusCode).not.toBe(429);
    }
    expect((await call('2001:db8:77:1:ffff:ffff:ffff:ffff')).statusCode).toBe(429);
    expect((await call('2001:db8:77:2::1')).statusCode).not.toBe(429);
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

  describe('failed-credential limiter (per address)', () => {
    const badFrom = (ip: string, i: number) =>
      t.app.inject(
        i % 2 === 0
          ? { method: 'GET', url: '/repos', headers: { authorization: `Bearer ddg_pat_guess${i}`, 'x-forwarded-for': ip } }
          : { method: 'GET', url: '/repos', headers: { cookie: `__Host-ddg_session=guess${i}`, 'x-forwarded-for': ip } },
      );
    const exhaust = async (ip: string) => {
      for (let i = 0; i < DEFAULT_REJECTION_LIMIT.max; i++) {
        expect((await badFrom(ip, i)).statusCode).toBe(401);
      }
    };

    it('(a) bad bearer / cookie requests from one IP: over budget → 429 for further bad credentials', async () => {
      const ip = '198.51.100.23';
      await exhaust(ip);
      const lookupsBefore = t.principals.calls;
      const blocked = await badFrom(ip, DEFAULT_REJECTION_LIMIT.max);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe('rate_limited');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(t.principals.calls - lookupsBefore).toBe(1); // one lookup, nothing beyond it

      // Another address is unaffected.
      const other = await badFrom('198.51.100.24', 0);
      expect(other.statusCode).toBe(401);
    });

    it('(b) in the same window a VALID session / bearer from the blocked IP still succeeds', async () => {
      const ip = '198.51.100.30';
      await exhaust(ip);
      expect((await badFrom(ip, 0)).statusCode).toBe(429);

      const session = t.principals.session('admin');
      const token = t.principals.token('admin');
      const viaSession = await t.app.inject(
        asSession(session, { method: 'GET', url: '/zz-rate-probe', headers: { 'x-forwarded-for': ip } }),
      );
      const viaToken = await t.app.inject(
        asToken(token, { method: 'GET', url: '/zz-rate-probe', headers: { 'x-forwarded-for': ip } }),
      );
      expect(viaSession.statusCode).toBe(200);
      expect(viaToken.statusCode).toBe(200);
      // …and the block on bad credentials still holds.
      expect((await badFrom(ip, 1)).statusCode).toBe(429);
    });

    it('(c) 100 cross-site CSRF-failing requests (valid cookie, wrong Origin) never cause a 429', async () => {
      const ip = '198.51.100.40';
      const victim = t.principals.session('admin');
      for (let i = 0; i < 100; i++) {
        const res = await t.app.inject(
          asSession(
            victim,
            {
              method: 'POST',
              url: '/settings/test-connection',
              payload: { provider: 'github' },
              headers: { 'x-forwarded-for': ip },
            },
            { origin: 'https://evil.example' },
          ),
        );
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('csrf_rejected');
      }
      const valid = await t.app.inject(
        asSession(victim, { method: 'GET', url: '/zz-rate-probe', headers: { 'x-forwarded-for': ip } }),
      );
      expect(valid.statusCode).toBe(200);
      // Nothing was charged: a bad credential from that IP is a plain 401.
      expect((await badFrom(ip, 0)).statusCode).toBe(401);
    });

    it('(d) anonymous no-credential 401s never count', async () => {
      const ip = '198.51.100.50';
      for (let i = 0; i < 100; i++) {
        const res = await t.app.inject(anonymous({ method: 'GET', url: '/repos', headers: { 'x-forwarded-for': ip } }));
        expect(res.statusCode).toBe(401);
      }
      // A signed-out session probe is public and never charged either.
      for (let i = 0; i < 5; i++) {
        const res = await t.app.inject(
          anonymous({ method: 'GET', url: '/auth/session', headers: { 'x-forwarded-for': ip } }),
        );
        expect(res.statusCode).not.toBe(429);
      }
      expect((await badFrom(ip, 0)).statusCode).toBe(401);
    });

    it('(e) IPv6 addresses in one /64 share a bucket; another /64 does not', async () => {
      // Half the budget from one host, half from another in the same /64.
      for (let i = 0; i < DEFAULT_REJECTION_LIMIT.max; i++) {
        const ip = i % 2 === 0 ? '2001:db8:aa:1::1' : '2001:db8:aa:1:ffff:1:2:3';
        expect((await badFrom(ip, i)).statusCode).toBe(401);
      }
      expect((await badFrom('2001:db8:aa:1:dead:beef::9', 0)).statusCode).toBe(429);
      expect((await badFrom('2001:db8:aa:2::1', 0)).statusCode).toBe(401);
    });
  });
});

describe('rejectionKey', () => {
  it('keeps IPv4 whole, folds IPv4-mapped IPv6, and keys IPv6 by /64', () => {
    expect(rejectionKey('203.0.113.7')).toBe('203.0.113.7');
    expect(rejectionKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rejectionKey('2001:db8:aa:1::1')).toBe('2001:db8:aa:1::/64');
    expect(rejectionKey('2001:0db8:00aa:0001:ffff:1:2:3')).toBe('2001:db8:aa:1::/64');
    expect(rejectionKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rejectionKey('::1')).toBe('0:0:0:0::/64');
    expect(rejectionKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(rejectionKey('not-an-ip')).toBe('not-an-ip');
  });

  it('folds every spelling of an IPv4-mapped address to its dotted IPv4 key', () => {
    for (const spelling of [
      '::ffff:1.2.3.4',
      '::FFFF:1.2.3.4',
      '::ffff:102:304',
      '::ffff:0102:0304',
      '0:0:0:0:0:ffff:102:304',
      '0000:0000:0000:0000:0000:ffff:0102:0304',
      '0:0:0:0:0:ffff:1.2.3.4',
      '0::ffff:102:304',
    ]) {
      expect(rejectionKey(spelling), spelling).toBe('1.2.3.4');
    }
    // Two distinct IPv4 clients never share a bucket via the mapped form…
    expect(rejectionKey('::ffff:a00:7')).toBe('10.0.0.7');
    expect(rejectionKey('::ffff:a00:8')).toBe('10.0.0.8');
    expect(rejectionKey('::ffff:ffff:ffff')).toBe('255.255.255.255');
    // …and near-misses that are NOT IPv4-mapped stay IPv6 /64 buckets.
    expect(rejectionKey('::fffe:102:304')).toBe('0:0:0:0::/64');
    expect(rejectionKey('1::ffff:102:304')).toBe('1:0:0:0::/64');
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

  it('(f) eviction: a blocked entry survives filling the map; low-count entries go first', () => {
    let now = 1_000_000;
    const capacity = 100;
    const limiter = new RejectionLimiter({ max: 3, windowMs: 60_000 }, () => now, capacity);
    for (let i = 0; i < 3; i++) limiter.hit('attacker');
    limiter.hit('busy');
    limiter.hit('busy');
    expect(limiter.blockedFor('attacker')).not.toBeNull();

    // Flood with fresh addresses well past capacity.
    for (let i = 0; i < capacity * 5; i++) limiter.hit(`flood-${i}`);
    expect(limiter.size).toBeLessThanOrEqual(capacity);
    expect(limiter.blockedFor('attacker')).not.toBeNull();

    // Expired windows are freed before any live one.
    now += 60_000;
    expect(limiter.blockedFor('attacker')).toBeNull();
  });

  it('(f) a map full of over-budget entries never evicts them; a new address is just not tracked', () => {
    const now = 1_000_000;
    const capacity = 10;
    const limiter = new RejectionLimiter({ max: 2, windowMs: 60_000 }, () => now, capacity);
    for (let k = 0; k < capacity; k++) for (let i = 0; i < 2; i++) limiter.hit(`blocked-${k}`);
    limiter.hit('newcomer');
    expect(limiter.size).toBe(capacity);
    for (let k = 0; k < capacity; k++) expect(limiter.blockedFor(`blocked-${k}`)).not.toBeNull();
    expect(limiter.blockedFor('newcomer')).toBeNull();
  });
});
