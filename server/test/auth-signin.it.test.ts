import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { VerifiedIdentity } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import * as schema from '../src/db/schema.js';
import { OAUTH_BINDING_COOKIE, OAUTH_FLOW_TTL_MS, SESSION_COOKIE } from '../src/modules/identity/constants.js';
import {
  anonymous,
  asSession,
  buildGoogleApp,
  TEST_ORIGIN,
  type GoogleTestApp,
} from './helpers/google-mode.js';

/**
 * T22 — Google sign-in over HTTP (google mode, real Postgres, MockIdentityProvider).
 * AC-6/16 return target, AC-7 state, AC-8/15 IdP failures, AC-9/10 admission,
 * AC-11/12/13 user upsert, AC-14 deactivated, AC-17/18 allowlist, AC-24
 * cookies + rotation, AC-26 sign-out replay, AC-62 plain-HTTP callback, plus
 * the session probe and local-mode `auth_disabled`.
 */
const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;
if (!hasDocker) console.warn('[auth-signin] Docker not available — skipping Testcontainers tests.');

let seq = 0;
const uniq = () => `${++seq}-${Math.random().toString(36).slice(2, 8)}`;

function identity(over: Partial<VerifiedIdentity> = {}): VerifiedIdentity {
  const n = uniq();
  return {
    subject: `sub-${n}`,
    email: `person${n}@onlytraf.com`,
    emailVerified: true,
    hostedDomain: 'onlytraf.com',
    name: `Person ${n}`,
    avatarUrl: null,
    ...over,
  };
}

function setCookieHeaders(res: LightMyRequestResponse): string[] {
  const h = res.headers['set-cookie'];
  return h === undefined ? [] : Array.isArray(h) ? h : [String(h)];
}

function cookieValue(res: LightMyRequestResponse, name: string): string | undefined {
  return res.cookies.find((c) => c.name === name && c.value !== '')?.value;
}

function errorOf(res: LightMyRequestResponse): string | null {
  const loc = String(res.headers.location ?? '');
  if (!loc.startsWith(`${TEST_ORIGIN}/sign-in?`)) return null;
  return new URL(loc).searchParams.get('error');
}

interface Flow {
  state: string;
  binding: string;
  res: LightMyRequestResponse;
}

async function startFlow(t: GoogleTestApp, returnTo?: string): Promise<Flow> {
  const qs = returnTo === undefined ? '' : `?return_to=${encodeURIComponent(returnTo)}`;
  const res = await t.app.inject(anonymous({ method: 'GET', url: `/auth/google/start${qs}` }));
  expect(res.statusCode).toBe(302);
  const state = new URL(String(res.headers.location)).searchParams.get('state');
  const binding = cookieValue(res, OAUTH_BINDING_COOKIE);
  expect(state).toBeTruthy();
  expect(binding).toBeTruthy();
  return { state: state!, binding: binding!, res };
}

interface CallbackInput {
  code?: string;
  state?: string;
  binding?: string;
  /** Extra `Cookie` pairs (e.g. a pre-existing session). */
  cookies?: string[];
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** Default true — send `x-forwarded-proto: https` like the proxy does. */
  https?: boolean;
}

function callbackRequest(input: CallbackInput): InjectOptions {
  const q = new URLSearchParams();
  if (input.code !== undefined) q.set('code', input.code);
  if (input.state !== undefined) q.set('state', input.state);
  for (const [k, v] of Object.entries(input.query ?? {})) q.set(k, v);
  const cookies = [
    ...(input.binding !== undefined ? [`${OAUTH_BINDING_COOKIE}=${input.binding}`] : []),
    ...(input.cookies ?? []),
  ];
  const req: InjectOptions = {
    method: 'GET',
    url: `/auth/google/callback?${q.toString()}`,
    headers: { ...(cookies.length ? { cookie: cookies.join('; ') } : {}), ...input.headers },
  };
  return input.https === false ? req : anonymous(req);
}

/** One Postgres for the whole file (each describe builds its own app on it). */
let pg: PgFixture;

d('identity routes (Postgres)', () => {
  beforeAll(async () => {
    pg = await startPg();
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  describe('Google sign-in routes (google mode)', () => {
    let t: GoogleTestApp;
    const logLines: string[] = [];

    beforeAll(async () => {
      t = await buildGoogleApp({ pg, logStream: { write: (l) => void logLines.push(l) } });
    });

    afterAll(async () => {
      await t?.close();
    });

    const count = async (table: typeof schema.users | typeof schema.sessions | typeof schema.workspaceMembers) => {
      const [row] = await t.db.select({ n: sql<number>`count(*)::int` }).from(table);
      return row!.n;
    };

    /** Full happy-path sign-in for `who`; returns the callback response + new session value. */
    async function signInAs(who: VerifiedIdentity, opts: { returnTo?: string; cookies?: string[] } = {}) {
      const flow = await startFlow(t, opts.returnTo);
      const code = `code-${uniq()}`;
      t.idp.scriptCode(code, who);
      const res = await t.app.inject(
        callbackRequest({ code, state: flow.state, binding: flow.binding, cookies: opts.cookies }),
      );
      return { res, flow, code, session: cookieValue(res, SESSION_COOKIE) };
    }

    const probe = (session: string) =>
      t.app.inject(anonymous({ method: 'GET', url: '/auth/session', headers: { cookie: `${SESSION_COOKIE}=${session}` } }));

    it('signed-out session probe → 401 unauthenticated with details.allowed_domain', async () => {
      const res = await t.app.inject(anonymous({ method: 'GET', url: '/auth/session' }));
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toMatchObject({ code: 'unauthenticated', details: { allowed_domain: 'onlytraf.com' } });
    });

    it('start: 302 to the IdP with PKCE + a Lax, Secure, HttpOnly, host-only binding cookie (AC-7)', async () => {
      const { res } = await startFlow(t, '/repos');
      const loc = new URL(String(res.headers.location));
      expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
      expect(loc.searchParams.get('nonce')).toBeTruthy();
      const raw = setCookieHeaders(res).find((c) => c.startsWith(`${OAUTH_BINDING_COOKIE}=`))!;
      expect(raw).toMatch(/; HttpOnly/i);
      expect(raw).toMatch(/; Secure/i);
      expect(raw).toMatch(/; SameSite=Lax/i);
      expect(raw).toMatch(/; Path=\//i);
      expect(raw).not.toMatch(/Domain=/i);
      expect(raw).toMatch(new RegExp(`Max-Age=${OAUTH_FLOW_TTL_MS / 1000}`));
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('AC-6 / AC-16: return target round-trips; off-site targets fall back to /', async () => {
      const ok = await signInAs(identity(), { returnTo: '/repos/abc/pulls?tab=open' });
      expect(ok.res.statusCode).toBe(302);
      expect(ok.res.headers.location).toBe(`${TEST_ORIGIN}/repos/abc/pulls?tab=open`);

      for (const bad of ['https://evil.io', '//evil.io', 'javascript:alert(1)', '/\\evil.io']) {
        const r = await signInAs(identity(), { returnTo: bad });
        expect(r.res.headers.location, bad).toBe(`${TEST_ORIGIN}/`);
      }
    });

    it('AC-11 + AC-24: first sign-in → one user + Member membership, a fresh opaque session cookie', async () => {
      const who = identity({ avatarUrl: 'https://lh3.googleusercontent.com/a/pic' });
      const usersBefore = await count(schema.users);
      const { res, session } = await signInAs(who);
      expect(await count(schema.users)).toBe(usersBefore + 1);

      const raw = setCookieHeaders(res).find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`))!;
      expect(raw).toMatch(/; HttpOnly/i);
      expect(raw).toMatch(/; Secure/i);
      expect(raw).toMatch(/; SameSite=Lax/i);
      expect(raw).toMatch(/; Path=\//i);
      expect(raw).not.toMatch(/Domain=/i);
      // Opaque: ≥256 bits, carries no identity data.
      expect(session!.length).toBeGreaterThanOrEqual(43);
      expect(Buffer.from(session!, 'base64url').toString('latin1')).not.toContain(who.email);
      expect(session).not.toContain(who.email.split('@')[0]);
      // The spent binding cookie is cleared.
      expect(setCookieHeaders(res).some((c) => c.startsWith(`${OAUTH_BINDING_COOKIE}=;`))).toBe(true);

      const me = await probe(session!);
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({
        mode: 'google',
        user: { email: who.email, name: who.name, role: 'member', avatar_url: 'https://lh3.googleusercontent.com/a/pic' },
        allowed_domain: 'onlytraf.com',
      });
      expect(me.json().workspace.id).toBe(t.workspaceId);

      const members = await t.app.inject(
        asSession({ cookie: `${SESSION_COOKIE}=${session}`, sessionId: session! }, { method: 'GET', url: '/members' }),
      );
      expect(members.json().members.find((m: { email: string }) => m.email === who.email)).toMatchObject({
        role: 'member',
        status: 'active',
      });
    });

    it('avatar off Google\'s image host is dropped (untrusted claim)', async () => {
      const { session } = await signInAs(identity({ avatarUrl: 'https://evil.io/x.png' }));
      expect((await probe(session!)).json().user.avatar_url).toBeNull();
    });

    it('AC-24: a session the browser already held is discarded, not reused', async () => {
      const who = identity();
      const first = await signInAs(who);
      const second = await signInAs(who, { cookies: [`${SESSION_COOKIE}=${first.session}`] });
      expect(second.session).toBeTruthy();
      expect(second.session).not.toBe(first.session);
      expect((await probe(first.session!)).statusCode).toBe(401);
      expect((await probe(second.session!)).statusCode).toBe(200);
    });

    it('AC-7: missing, mismatched, reused, cross-browser or expired state → auth_state_invalid, no session', async () => {
      const sessionsBefore = await count(schema.sessions);
      const who = identity();

      // missing state
      const a = await startFlow(t);
      t.idp.scriptCode('c-missing', who);
      let res = await t.app.inject(callbackRequest({ code: 'c-missing', binding: a.binding }));
      expect(errorOf(res)).toBe('auth_state_invalid');

      // mismatched state
      res = await t.app.inject(callbackRequest({ code: 'c-x', state: 'not-a-real-state', binding: a.binding }));
      expect(errorOf(res)).toBe('auth_state_invalid');

      // cross-browser: valid state, another flow's binding cookie / no binding cookie
      const b = await startFlow(t);
      const c = await startFlow(t);
      res = await t.app.inject(callbackRequest({ code: 'c-x', state: b.state, binding: c.binding }));
      expect(errorOf(res)).toBe('auth_state_invalid');
      res = await t.app.inject(callbackRequest({ code: 'c-x', state: c.state }));
      expect(errorOf(res)).toBe('auth_state_invalid');

      // reused
      const e = await startFlow(t);
      t.idp.scriptCode('c-reuse', who);
      res = await t.app.inject(callbackRequest({ code: 'c-reuse', state: e.state, binding: e.binding }));
      expect(cookieValue(res, SESSION_COOKIE)).toBeTruthy();
      const afterFirst = await count(schema.sessions);
      res = await t.app.inject(callbackRequest({ code: 'c-reuse', state: e.state, binding: e.binding }));
      expect(errorOf(res)).toBe('auth_state_invalid');
      expect(cookieValue(res, SESSION_COOKIE)).toBeUndefined();

      // expired (> 10 min)
      const f = await startFlow(t);
      t.clock.advance(OAUTH_FLOW_TTL_MS + 1000);
      res = await t.app.inject(callbackRequest({ code: 'c-reuse', state: f.state, binding: f.binding }));
      expect(errorOf(res)).toBe('auth_state_invalid');
      expect(cookieValue(res, SESSION_COOKIE)).toBeUndefined();

      // only the one successful callback created a session
      expect(afterFirst).toBe(sessionsBefore + 1);
      expect(await count(schema.sessions)).toBe(afterFirst);
    });

    it('AC-8 / AC-15: IdP token failure → auth_token_invalid; IdP down → auth_idp_unavailable; DB unchanged', async () => {
      const users = await count(schema.users);
      const sessions = await count(schema.sessions);
      try {
        t.idp.fail('bad_token');
        expect(errorOf((await signInAs(identity())).res)).toBe('auth_token_invalid');
        t.idp.fail('idp_down');
        expect(errorOf((await signInAs(identity())).res)).toBe('auth_idp_unavailable');
      } finally {
        t.idp.fail(null);
      }
      // Google redirected back with an error and no code.
      const flow = await startFlow(t);
      const res = await t.app.inject(
        callbackRequest({ state: flow.state, binding: flow.binding, query: { error: '<script>access_denied</script>' } }),
      );
      expect(errorOf(res)).toBe('auth_idp_unavailable');
      expect(String(res.headers.location)).not.toContain('script');
      expect(await count(schema.users)).toBe(users);
      expect(await count(schema.sessions)).toBe(sessions);
    });

    it('AC-9: non-corporate / unverified identities are rejected and create no user', async () => {
      const users = await count(schema.users);
      const cases: Array<[Partial<VerifiedIdentity>, string]> = [
        [{ email: 'x@gmail.com', hostedDomain: undefined }, 'auth_domain_not_allowed'],
        [{ email: 'x@sub.onlytraf.com' }, 'auth_domain_not_allowed'],
        [{ email: 'x@onlytraf.com.evil.io' }, 'auth_domain_not_allowed'],
        [{ emailVerified: false }, 'auth_email_unverified'],
      ];
      for (const [over, code] of cases) {
        const { res, session } = await signInAs(identity(over));
        expect(errorOf(res), JSON.stringify(over)).toBe(code);
        expect(session).toBeUndefined();
      }
      expect(await count(schema.users)).toBe(users);
    });

    it('AC-10: injected hd/email query and a role header are ignored', async () => {
      const users = await count(schema.users);
      const gmail = identity({ email: 'mallory@gmail.com', hostedDomain: undefined });
      const flow = await startFlow(t);
      t.idp.scriptCode('c-inject', gmail);
      const res = await t.app.inject(
        callbackRequest({
          code: 'c-inject',
          state: flow.state,
          binding: flow.binding,
          query: { hd: 'onlytraf.com', email: 'boss@onlytraf.com', role: 'admin' },
          headers: { role: 'admin', 'x-role': 'admin' },
        }),
      );
      expect(errorOf(res)).toBe('auth_domain_not_allowed');
      expect(await count(schema.users)).toBe(users);

      const ok = await signInAs(identity());
      const me = await t.app.inject(
        anonymous({
          method: 'GET',
          url: '/auth/session',
          headers: { cookie: `${SESSION_COOKIE}=${ok.session}`, role: 'admin', 'x-devdigest-role': 'admin' },
        }),
      );
      expect(me.json().user.role).toBe('member');
    });

    it('AC-12: a returning user is matched by subject; profile refreshed, role unchanged', async () => {
      const who = identity();
      const first = await signInAs(who);
      const me1 = (await probe(first.session!)).json();
      await t.setRole({ userId: me1.user.id }, 'admin');
      const users = await count(schema.users);

      const renamed = { ...who, name: 'Renamed Person', email: who.email.replace('person', 'renamed') };
      const second = await signInAs(renamed);
      const me2 = (await probe(second.session!)).json();
      expect(me2.user).toMatchObject({ id: me1.user.id, name: 'Renamed Person', email: renamed.email, role: 'admin' });
      expect(await count(schema.users)).toBe(users);
    });

    it('AC-13: two concurrent first sign-ins of one subject → one user, one membership', async () => {
      const who = identity();
      const [f1, f2] = [await startFlow(t), await startFlow(t)];
      t.idp.scriptCode('c-par-1', who).scriptCode('c-par-2', who);
      const [r1, r2] = await Promise.all([
        t.app.inject(callbackRequest({ code: 'c-par-1', state: f1.state, binding: f1.binding })),
        t.app.inject(callbackRequest({ code: 'c-par-2', state: f2.state, binding: f2.binding })),
      ]);
      expect(cookieValue(r1, SESSION_COOKIE)).toBeTruthy();
      expect(cookieValue(r2, SESSION_COOKIE)).toBeTruthy();
      const rows = await t.db.select().from(schema.users).where(eq(schema.users.googleSub, who.subject));
      expect(rows).toHaveLength(1);
      const memberships = await t.db
        .select()
        .from(schema.workspaceMembers)
        .where(and(eq(schema.workspaceMembers.userId, rows[0]!.id), eq(schema.workspaceMembers.workspaceId, t.workspaceId)));
      expect(memberships).toHaveLength(1);
    });

    it('AC-14: a deactivated member cannot sign back in; membership stays deactivated', async () => {
      const who = identity();
      const first = await signInAs(who);
      const me = (await probe(first.session!)).json();
      await t.setStatus({ userId: me.user.id }, 'deactivated');

      const again = await signInAs(who);
      expect(errorOf(again.res)).toBe('auth_account_deactivated');
      expect(again.session).toBeUndefined();
      const [m] = await t.db
        .select()
        .from(schema.workspaceMembers)
        .where(and(eq(schema.workspaceMembers.userId, me.user.id), eq(schema.workspaceMembers.workspaceId, t.workspaceId)));
      expect(m!.status).toBe('deactivated');
    });

    it('AC-26: sign-out deletes the session, clears the cookie, audits; replay → 401', async () => {
      const { session } = await signInAs(identity());
      const cred = { cookie: `${SESSION_COOKIE}=${session}`, sessionId: session! };
      const out = await t.app.inject(asSession(cred, { method: 'POST', url: '/auth/sign-out' }));
      expect(out.statusCode).toBe(200);
      expect(out.json()).toEqual({ ok: true });
      const cleared = setCookieHeaders(out).find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
      expect(cleared).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
      expect(cleared).toMatch(/Max-Age=0/i);

      expect((await probe(session!)).statusCode).toBe(401);
      const replay = await t.app.inject(asSession(cred, { method: 'GET', url: '/members' }));
      expect(replay.statusCode).toBe(401);

      const events = await t.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'auth.sign_out'));
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it('AC-62: a plain-HTTP callback sets no cookie and does not consume the flow', async () => {
      const who = identity();
      const flow = await startFlow(t);
      t.idp.scriptCode('c-http', who);
      const plain = await t.app.inject(
        callbackRequest({ code: 'c-http', state: flow.state, binding: flow.binding, https: false }),
      );
      expect(plain.statusCode).toBe(302);
      expect(setCookieHeaders(plain)).toEqual([]);
      expect(errorOf(plain)).toBe('auth_state_invalid');

      const plainStart = await t.app.inject({ method: 'GET', url: '/auth/google/start' });
      expect(plainStart.statusCode).toBe(302);
      expect(setCookieHeaders(plainStart)).toEqual([]);

      // The flow survived: the same callback over HTTPS succeeds.
      const ok = await t.app.inject(callbackRequest({ code: 'c-http', state: flow.state, binding: flow.binding }));
      expect(cookieValue(ok, SESSION_COOKIE)).toBeTruthy();
    });

    it('never logs or audits code, state, binding or session values', async () => {
      const who = identity();
      const { session, flow, code } = await signInAs(who);
      const logs = logLines.join('\n');
      for (const secret of [session!, flow.state, flow.binding, code]) {
        expect(logs).not.toContain(secret);
      }
      const audit = JSON.stringify(await t.db.select().from(schema.auditEvents));
      for (const secret of [session!, flow.state, flow.binding]) {
        expect(audit).not.toContain(secret);
      }
    });
  });

  describe('Google sign-in — admin allowlist (AC-17, AC-18)', () => {
    let t: GoogleTestApp;

    beforeAll(async () => {
      t = await buildGoogleApp({ pg, env: { AUTH_ADMIN_EMAILS: 'boss@onlytraf.com, lead@onlytraf.com' } });
    });

    afterAll(async () => {
      await t?.close();
    });

    async function signIn(who: VerifiedIdentity) {
      const flow = await startFlow(t);
      const code = `code-${uniq()}`;
      t.idp.scriptCode(code, who);
      const res = await t.app.inject(callbackRequest({ code, state: flow.state, binding: flow.binding }));
      const session = cookieValue(res, SESSION_COOKIE)!;
      const me = await t.app.inject(
        anonymous({ method: 'GET', url: '/auth/session', headers: { cookie: `${SESSION_COOKIE}=${session}` } }),
      );
      return { session, me: me.json() };
    }

    it('allowlisted first sign-in → Admin; an Admin-demoted allowlisted user stays Member', async () => {
      const boss = identity({ email: 'Boss@OnlyTraf.com' });
      const first = await signIn(boss);
      expect(first.me.user.role).toBe('admin');

      // A second allowlisted user joins (Admin), then demotes boss in the UI (AC-18).
      const lead = await signIn(identity({ email: 'lead@onlytraf.com' }));
      expect(lead.me.user.role).toBe('admin');
      const demote = await t.app.inject(
        asSession(
          { cookie: `${SESSION_COOKIE}=${lead.session}`, sessionId: lead.session },
          { method: 'PATCH', url: `/members/${first.me.user.id}`, payload: { role: 'member' } },
        ),
      );
      expect(demote.statusCode).toBe(200);
      expect((await signIn(boss)).me.user.role).toBe('member');
    });

    it('a non-allowlisted first sign-in → Member', async () => {
      expect((await signIn(identity())).me.user.role).toBe('member');
    });
  });

  describe('identity routes — local mode', () => {
    let app: Awaited<ReturnType<typeof buildApp>>;

    beforeAll(async () => {
      const { bootstrap } = await import('../src/db/bootstrap.js');
      await bootstrap(pg.handle.db);
      const config = loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        AUTH_MODE: 'local',
        DATABASE_URL: pg.url,
      } as NodeJS.ProcessEnv);
      app = await buildApp({ config, db: pg.handle.db });
      await app.ready();
    });

    afterAll(async () => {
      await app?.close();
    });

    it('session probe answers the local system user as Admin', async () => {
      const res = await app.inject({ method: 'GET', url: '/auth/session' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ mode: 'local', user: { role: 'admin', avatar_url: null } });
      expect(res.json().allowed_domain).toBeUndefined();
    });

    it('Google routes, sign-out and tokens → 404 auth_disabled; members list works', async () => {
      for (const [method, url] of [
        ['GET', '/auth/google/start'],
        ['GET', '/auth/google/callback?code=x&state=y'],
        ['POST', '/auth/sign-out'],
        ['GET', '/tokens'],
        ['POST', '/tokens'],
      ] as const) {
        const res = await app.inject({
          method,
          url,
          ...(method === 'POST' && url === '/tokens' ? { payload: { name: 'x' } } : {}),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
        expect(res.json().error.code).toBe('auth_disabled');
        expect(setCookieHeaders(res)).toEqual([]);
      }
      const members = await app.inject({ method: 'GET', url: '/members' });
      expect(members.statusCode).toBe(200);
      expect(members.json()).toHaveProperty('has_active_admin');
    });
  });
});
