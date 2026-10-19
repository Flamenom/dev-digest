import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { performance } from 'node:perf_hooks';
import type { AuthRequestLike } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { anonymous, buildGoogleApp, type GoogleTestApp, type TestUser } from './helpers/google-mode.js';
import { newSessionId, sha256Hex } from '../src/platform/crypto/tokens.js';
import { OAUTH_BINDING_COOKIE, SESSION_COOKIE, SESSION_ABSOLUTE_MS } from '../src/modules/identity/constants.js';
import * as t from '../src/db/schema.js';

/**
 * T28 — auth performance NFRs (google mode, real Postgres, server-side timing only).
 *
 *  - Auth overhead: resolving a session or token plus the role ≤ 5 ms p95 with
 *    1 000 active sessions (measured on `container.principals.resolve`, the
 *    exact per-request work the guard does — DB lookup by hash + membership
 *    join + throttled touch).
 *  - Sign-in latency: the callback's server-side processing (mock IdP ⇒ no
 *    Google time) ≤ 300 ms p95 (`app.inject` of `/auth/google/callback`).
 *
 * Robustness: warm-up first, ≥ 200 samples, p95 (not max). The spec budgets
 * are asserted by default; set `PERF_LENIENT=1` on a known-slow CI host to
 * widen them 4× (the numbers are always printed).
 */
const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;
if (!hasDocker) console.warn('[auth-perf] Docker not available — skipping.');

const LENIENCY = process.env.PERF_LENIENT === '1' ? 4 : 1;
const RESOLVE_P95_MS = 5 * LENIENCY;
const CALLBACK_P95_MS = 300 * LENIENCY;

const SESSIONS = 1_000;
const USERS = 50;
const WARMUP = 50;
const SAMPLES = 400;
const CALLBACK_WARMUP = 20;
const CALLBACK_SAMPLES = 200;

function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)]!;
}

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95), max: s[s.length - 1]! };
}

const fmt = (x: { n: number; p50: number; p95: number; max: number }) =>
  `n=${x.n} p50=${x.p50.toFixed(2)}ms p95=${x.p95.toFixed(2)}ms max=${x.max.toFixed(2)}ms`;

d('auth performance (T28, Postgres)', () => {
  let pg: PgFixture;
  let g: GoogleTestApp;
  let users: TestUser[];
  const sessionIds: string[] = [];

  beforeAll(async () => {
    pg = await startPg();
    g = await buildGoogleApp({ pg });
    users = [];
    for (let i = 0; i < USERS; i++) users.push(await g.createUser({ role: i % 5 === 0 ? 'admin' : 'member' }));

    // 1 000 active sessions, bulk-inserted (hash only, like the real store).
    // Half were last seen > the touch throttle ago, so their first resolution
    // also performs the `last_seen_at` write — the realistic worst case.
    const now = g.clock.now().getTime();
    const rows = [];
    for (let i = 0; i < SESSIONS; i++) {
      const id = newSessionId();
      sessionIds.push(id);
      rows.push({
        idHash: sha256Hex(id),
        userId: users[i % USERS]!.userId,
        workspaceId: g.workspaceId,
        createdAt: new Date(now - 3_600_000),
        lastSeenAt: new Date(i % 2 === 0 ? now - 120_000 : now),
        expiresAt: new Date(now - 3_600_000 + SESSION_ABSOLUTE_MS),
      });
    }
    for (let i = 0; i < rows.length; i += 250) await g.db.insert(t.sessions).values(rows.slice(i, i + 250));
  }, 180_000);

  afterAll(async () => {
    await g?.close();
    await pg?.stop();
  });

  it(`principal resolution (session) p95 ≤ ${RESOLVE_P95_MS} ms with ${SESSIONS} active sessions`, async () => {
    const principals = g.container.principals;
    const req = (id: string): AuthRequestLike => ({ headers: { cookie: `${SESSION_COOKIE}=${id}` } });
    const pick = (i: number) => sessionIds[(i * 7919) % SESSIONS]!;

    for (let i = 0; i < WARMUP; i++) expect(await principals.resolve(req(pick(i + SAMPLES)))).not.toBeNull();

    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const r = req(pick(i));
      const t0 = performance.now();
      const p = await principals.resolve(r);
      samples.push(performance.now() - t0);
      expect(p?.via).toBe('session');
    }
    const s = stats(samples);
    console.info(`[auth-perf] session resolve ${fmt(s)}`);
    expect(s.p95).toBeLessThanOrEqual(RESOLVE_P95_MS);
  }, 60_000);

  it(`principal resolution (bearer token) p95 ≤ ${RESOLVE_P95_MS} ms`, async () => {
    const principals = g.container.principals;
    const tokens = [];
    for (let i = 0; i < 20; i++) tokens.push(await g.createToken(users[i]!));
    const req = (auth: string): AuthRequestLike => ({ headers: { authorization: auth } });

    for (let i = 0; i < WARMUP; i++) await principals.resolve(req(tokens[i % tokens.length]!.authorization));
    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const r = req(tokens[i % tokens.length]!.authorization);
      const t0 = performance.now();
      const p = await principals.resolve(r);
      samples.push(performance.now() - t0);
      expect(p?.via).toBe('token');
    }
    const s = stats(samples);
    console.info(`[auth-perf] token resolve ${fmt(s)}`);
    expect(s.p95).toBeLessThanOrEqual(RESOLVE_P95_MS);
  }, 60_000);

  it(`sign-in callback server-side p95 ≤ ${CALLBACK_P95_MS} ms (mock IdP)`, async () => {
    let n = 0;
    const once = async (): Promise<number> => {
      n++;
      const start = await g.app.inject(anonymous({ method: 'GET', url: '/auth/google/start' }));
      const state = new URL(String(start.headers.location)).searchParams.get('state')!;
      const binding = start.cookies.find((c) => c.name === OAUTH_BINDING_COOKIE)!.value;
      const code = `perf-code-${n}`;
      // Alternate first sign-ins (user create) and returning users (profile refresh).
      const who = n % 2 === 0 ? users[n % USERS]! : null;
      g.idp.scriptCode(code, {
        subject: who ? who.subject : `perf-sub-${n}`,
        email: who ? who.email : `perf${n}@onlytraf.com`,
        hostedDomain: 'onlytraf.com',
        emailVerified: true,
        name: who ? who.name : `Perf ${n}`,
      });
      const opts = anonymous({
        method: 'GET',
        url: `/auth/google/callback?${new URLSearchParams({ code, state }).toString()}`,
        headers: { cookie: `${OAUTH_BINDING_COOKIE}=${binding}` },
      });
      const t0 = performance.now();
      const res = await g.app.inject(opts);
      const ms = performance.now() - t0;
      expect(res.statusCode).toBe(302);
      expect(res.cookies.some((c) => c.name === SESSION_COOKIE && c.value !== '')).toBe(true);
      return ms;
    };

    for (let i = 0; i < CALLBACK_WARMUP; i++) await once();
    const samples: number[] = [];
    for (let i = 0; i < CALLBACK_SAMPLES; i++) samples.push(await once());
    const s = stats(samples);
    console.info(`[auth-perf] callback ${fmt(s)}`);
    expect(s.p95).toBeLessThanOrEqual(CALLBACK_P95_MS);
  }, 120_000);
});
