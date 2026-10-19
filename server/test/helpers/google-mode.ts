/**
 * Google-mode (multi-user) test helper — shared by T21–T28.
 *
 * Two ways to build an app with `AUTH_MODE=google`; neither uses an HTTP
 * login shortcut (AC-63) — credentials are minted directly.
 *
 * 1. HERMETIC (no Docker) — `buildHermeticGoogleApp()`
 *    Fake principals (`FakePrincipals`), a DB that is unreachable
 *    (`HERMETIC_DATABASE_URL`) or a recording `db` proxy, `bootChecks: false`.
 *    Use for guard / policy / CSRF / CORS / rate-limit tests.
 *
 *      const t = await buildHermeticGoogleApp({ overrides: { github: new MockGitHubClient() } });
 *      const admin = t.principals.session('admin');          // { cookie, principal }
 *      const bot = t.principals.token('member');             // { authorization, principal }
 *      await t.app.inject(asSession(admin, { method: 'POST', url: '/settings/test-connection',
 *        payload: { provider: 'github' } }));                // cookie + Origin + CSRF header
 *      await t.app.inject(asToken(bot, { method: 'GET', url: '/repos' }));
 *      await t.close();
 *
 * 2. POSTGRES (`*.it.test.ts`) — `buildGoogleApp({ pg })`
 *    Real `PrincipalService` over `IdentityRepository`, `MockIdentityProvider`
 *    (`t.idp`) and a controllable `TestClock` (`t.clock`). The DB is
 *    bootstrapped (default workspace + system user; `seed: true` runs the
 *    full demo `seed()` instead). Users, sessions and tokens are created
 *    straight through the repository:
 *
 *      const pg = await startPg();
 *      const t = await buildGoogleApp({ pg });
 *      const alice = await t.createUser({ email: 'alice@onlytraf.com', role: 'member' });
 *      const s = await t.signIn(alice);                      // server-side session → cookie
 *      const tok = await t.createToken(alice, { days: 30 }); // ddg_pat_… bearer
 *      await t.app.inject(asSession(s, { method: 'GET', url: '/members' }));
 *      t.clock.advance(25 * 60 * 60 * 1000);                 // idle-expire the session
 *      await t.close();                                     // app only — pg is the caller's
 *
 *    `bootChecks` defaults to FALSE (no instance claim / secrets scan) so test
 *    files stay fast; pass `true` to exercise the boot sequence.
 *
 * Request shaping: `asSession()` adds the session cookie, the exact public
 * `Origin` and the `x-devdigest-csrf` header (what the web client sends);
 * `asToken()` adds only `Authorization: Bearer`. Both add
 * `x-forwarded-proto: https` — the test config trusts the inject address
 * (`TRUST_PROXY=127.0.0.1`), so `req.protocol === 'https'` like behind Caddy.
 * Pass `{ csrf: false }` / `{ origin: '…' }` to `asSession` to build attacks.
 */
import { randomBytes } from 'node:crypto';
import type { InjectOptions } from 'fastify';
import type { Clock, Principal, PrincipalProvider, Role, MemberStatus, AuthRequestLike } from '@devdigest/shared';
import { CSRF_HEADER } from '@devdigest/shared';
import { buildApp, type BuildAppOptions } from '../../src/app.js';
import { loadConfig, type AppConfig } from '../../src/platform/config.js';
import type { Container, ContainerOverrides } from '../../src/platform/container.js';
import type { Db } from '../../src/db/client.js';
import { bootstrap } from '../../src/db/bootstrap.js';
import { MockIdentityProvider } from '../../src/adapters/mocks.js';
import { newApiToken, newSessionId, sha256Hex } from '../../src/platform/crypto/tokens.js';
import { SESSION_COOKIE } from '../../src/modules/identity/constants.js';
import type { PgFixture } from './pg.js';

// ---- config -------------------------------------------------------------------

export const TEST_PUBLIC_HOSTNAME = 'devdigest.test';
export const TEST_ORIGIN = `https://${TEST_PUBLIC_HOSTNAME}`;
export const TEST_ALLOWED_DOMAIN = 'onlytraf.com';
/** Deterministic 32-byte master keys (base64). Never real secrets. */
export const TEST_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
export const TEST_MASTER_KEY_2 = Buffer.alloc(32, 9).toString('base64');
export const TEST_MASTER_KEY_3 = Buffer.alloc(32, 11).toString('base64');
/** Nothing listens here: a hermetic test that reaches the DB fails fast (5xx), never silently. */
export const HERMETIC_DATABASE_URL = 'postgres://nobody:nobody@127.0.0.1:1/none';
/** A syntactically valid uuid for `:id` params. */
export const TEST_UUID = '3e2a2b52-3b8c-4b34-9a34-0a4c8e2b1c11';

/**
 * The google-mode env. Built from scratch (NOT `process.env`) so a developer's
 * `.env` can't leak in. `extra` wins; `undefined` deletes a key.
 */
export function googleEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: HERMETIC_DATABASE_URL,
    AUTH_MODE: 'google',
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    AUTH_ALLOWED_DOMAIN: TEST_ALLOWED_DOMAIN,
    PUBLIC_HOSTNAME: TEST_PUBLIC_HOSTNAME,
    SECRETS_MASTER_KEY: TEST_MASTER_KEY,
    TRUST_PROXY: '127.0.0.1',
    ...extra,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env as NodeJS.ProcessEnv;
}

export function googleConfig(extra: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig(googleEnv(extra));
}

// ---- clock --------------------------------------------------------------------

/** A settable clock (inject via `overrides.clock`). Starts at a fixed instant. */
export class TestClock implements Clock {
  private t: number;
  constructor(start: Date | number = Date.UTC(2026, 9, 19, 12, 0, 0)) {
    this.t = typeof start === 'number' ? start : start.getTime();
  }
  readonly now = (): Date => new Date(this.t);
  set(at: Date | number): this {
    this.t = typeof at === 'number' ? at : at.getTime();
    return this;
  }
  advance(ms: number): this {
    this.t += ms;
    return this;
  }
}

// ---- credentials + request shaping ---------------------------------------------

export interface SessionCredential {
  /** Full `Cookie` header value (`__Host-ddg_session=<id>`). */
  cookie: string;
  /** Raw session id (only for assertions such as "never appears in logs"). */
  sessionId: string;
  principal?: Principal;
}

export interface TokenCredential {
  /** Full `Authorization` header value (`Bearer ddg_pat_…`). */
  authorization: string;
  /** Raw token value (assertions only). */
  token: string;
  tokenId?: string;
  principal?: Principal;
}

export interface AsSessionOptions {
  /** Send the `x-devdigest-csrf` header (default true). */
  csrf?: boolean;
  /** `Origin` to send (default the public origin); `null` omits the header. */
  origin?: string | null;
}

const FORWARDED_HTTPS = { 'x-forwarded-proto': 'https' } as const;

export const csrfHeaders = { origin: TEST_ORIGIN, [CSRF_HEADER]: '1' } as const;

/** A cookie-authenticated request exactly as the web client sends it. */
export function asSession(
  cred: SessionCredential,
  init: InjectOptions,
  opts: AsSessionOptions = {},
): InjectOptions {
  const headers: Record<string, string> = { ...FORWARDED_HTTPS, cookie: cred.cookie };
  const origin = opts.origin === undefined ? TEST_ORIGIN : opts.origin;
  if (origin !== null) headers.origin = origin;
  if (opts.csrf ?? true) headers[CSRF_HEADER] = '1';
  return { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } };
}

/** A bearer-token request (no Origin, no CSRF header — like the MCP server). */
export function asToken(cred: TokenCredential, init: InjectOptions): InjectOptions {
  return {
    ...init,
    headers: {
      ...FORWARDED_HTTPS,
      authorization: cred.authorization,
      ...(init.headers as Record<string, string> | undefined),
    },
  };
}

/** No credentials at all (still over "https"). */
export function anonymous(init: InjectOptions): InjectOptions {
  return { ...init, headers: { ...FORWARDED_HTTPS, ...(init.headers as Record<string, string> | undefined) } };
}

// ---- hermetic: fake principals -------------------------------------------------

export const FAKE_WORKSPACE_ID = '00000000-0000-4000-8000-0000000000aa';

function cookieValue(req: AuthRequestLike): string | undefined {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string') return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE) return v.join('=');
  }
  return undefined;
}

/**
 * In-memory `PrincipalProvider` with the same precedence as `PrincipalService`
 * (bearer wins over cookie). Mint credentials with `session()` / `token()`;
 * `failWith(err)` makes every resolve throw (fail-closed tests); `calls`
 * counts resolutions.
 */
export class FakePrincipals implements PrincipalProvider {
  private readonly sessions = new Map<string, Principal>();
  private readonly tokens = new Map<string, Principal>();
  private failure: Error | null = null;
  calls = 0;

  session(role: Role = 'member', userId = randomUuid()): SessionCredential & { principal: Principal } {
    const sessionId = randomBytes(32).toString('base64url');
    const principal: Principal = { userId, workspaceId: FAKE_WORKSPACE_ID, role, via: 'session', sessionId };
    this.sessions.set(sessionId, principal);
    return { cookie: `${SESSION_COOKIE}=${sessionId}`, sessionId, principal };
  }

  token(role: Role = 'member', userId = randomUuid()): TokenCredential & { principal: Principal } {
    const token = `ddg_pat_${randomBytes(32).toString('base64url')}`;
    const tokenId = randomUuid();
    const principal: Principal = { userId, workspaceId: FAKE_WORKSPACE_ID, role, via: 'token', tokenId };
    this.tokens.set(token, principal);
    return { authorization: `Bearer ${token}`, token, tokenId, principal };
  }

  failWith(err: Error | null): this {
    this.failure = err;
    return this;
  }

  readonly resolve = async (req: AuthRequestLike): Promise<Principal | null> => {
    this.calls++;
    if (this.failure) throw this.failure;
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && /^bearer\s/i.test(auth)) {
      return this.tokens.get(auth.replace(/^bearer\s+/i, '').trim()) ?? null;
    }
    const sid = cookieValue(req);
    return sid ? (this.sessions.get(sid) ?? null) : null;
  };
}

function randomUuid(): string {
  return globalThis.crypto.randomUUID();
}

// ---- hermetic: recorders --------------------------------------------------------

/** Names of every member called on a recording proxy. */
export interface CallLog {
  calls: string[];
  reset: () => void;
}

/**
 * Wrap `target` so every function member call is recorded (`calls`) before
 * delegating. With no target, every member is a recorded no-op returning
 * `undefined` (e.g. a `RepoOperations` stand-in).
 */
export function recording<T extends object>(name: string, target?: T): { value: T } & CallLog {
  const log: CallLog = {
    calls: [],
    reset: () => {
      log.calls.length = 0;
    },
  };
  const value = new Proxy((target ?? {}) as T, {
    get(obj, prop, receiver) {
      if (typeof prop === 'symbol' || prop === 'then') return Reflect.get(obj, prop, receiver);
      const member = target ? Reflect.get(obj, prop, receiver) : undefined;
      if (target && typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        log.calls.push(`${name}.${String(prop)}`);
        return typeof member === 'function' ? (member as (...a: unknown[]) => unknown).apply(obj, args) : undefined;
      };
    },
  });
  return Object.assign(log, { value });
}

/**
 * A `Db` stand-in that records and REJECTS every use — proves a request did
 * no database work (AC-28/29 "no DB write"). Boot-time touches (stale-run
 * reaping) happen before tests run; call `reset()` after `app.ready()`.
 */
export function recordingDb(): { db: Db } & CallLog {
  const log: CallLog = {
    calls: [],
    reset: () => {
      log.calls.length = 0;
    },
  };
  const db = new Proxy({} as Db, {
    get(_obj, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return () => {
        log.calls.push(`db.${prop}`);
        throw new Error(`hermetic test touched the database (db.${prop})`);
      };
    },
  });
  return Object.assign(log, { db });
}

export interface HermeticGoogleAppOptions {
  overrides?: ContainerOverrides;
  /** Extra env for `googleConfig()`. */
  env?: Record<string, string | undefined>;
  /** Use the recording DB proxy instead of the unreachable URL (default false). */
  recordDb?: boolean;
  rateLimit?: boolean;
  logStream?: BuildAppOptions['logStream'];
  /** Called after `buildApp` and before `ready()` — register stand-in routes here. */
  beforeReady?: (app: Awaited<ReturnType<typeof buildApp>>) => void | Promise<void>;
}

export interface HermeticGoogleApp {
  app: Awaited<ReturnType<typeof buildApp>>;
  container: Container;
  config: AppConfig;
  principals: FakePrincipals;
  /** Present when `recordDb: true`. */
  dbLog: CallLog | null;
  close: () => Promise<void>;
}

/** google-mode app with fake principals and no reachable database. Already `ready()`. */
export async function buildHermeticGoogleApp(
  opts: HermeticGoogleAppOptions = {},
): Promise<HermeticGoogleApp> {
  const config = googleConfig(opts.env);
  const principals = new FakePrincipals();
  const recDb = opts.recordDb ? recordingDb() : null;
  const app = await buildApp({
    config,
    db: recDb?.db,
    bootChecks: false,
    rateLimit: opts.rateLimit,
    logStream: opts.logStream,
    overrides: { principals, ...opts.overrides },
  });
  await opts.beforeReady?.(app);
  await app.ready();
  recDb?.reset();
  principals.calls = 0;
  return {
    app,
    container: app.container,
    config,
    principals,
    dbLog: recDb,
    close: () => app.close(),
  };
}

// ---- Postgres: real identity stack --------------------------------------------

export interface GoogleAppOptions {
  /** A started fixture (`startPg()`); its DB and URL are used. */
  pg: Pick<PgFixture, 'handle' | 'url'>;
  idp?: MockIdentityProvider;
  clock?: TestClock;
  overrides?: ContainerOverrides;
  env?: Record<string, string | undefined>;
  /** Run the google boot sequence (instance claim, secrets checks). Default false. */
  bootChecks?: boolean;
  rateLimit?: boolean;
  logStream?: BuildAppOptions['logStream'];
  /** Run the full demo `seed()` instead of the tenancy-only `bootstrap()`. */
  seed?: boolean;
}

export interface TestUser {
  userId: string;
  email: string;
  name: string;
  subject: string;
  role: Role;
}

export interface CreateUserInput {
  email?: string;
  name?: string;
  role?: Role;
  status?: MemberStatus;
  subject?: string;
}

export interface GoogleTestApp {
  app: Awaited<ReturnType<typeof buildApp>>;
  container: Container;
  config: AppConfig;
  db: Db;
  idp: MockIdentityProvider;
  clock: TestClock;
  workspaceId: string;
  /** The seeded system user (local actor). */
  systemUserId: string;
  createUser: (input?: CreateUserInput) => Promise<TestUser>;
  /** A fresh server-side session for `user` (hash stored; raw id in the cookie). */
  signIn: (user: Pick<TestUser, 'userId'>) => Promise<SessionCredential>;
  /** A personal API token for `user`, valid for `days` (default 90). */
  createToken: (
    user: Pick<TestUser, 'userId'>,
    opts?: { days?: number; name?: string },
  ) => Promise<TokenCredential>;
  setRole: (user: Pick<TestUser, 'userId'>, role: Role) => Promise<void>;
  setStatus: (user: Pick<TestUser, 'userId'>, status: MemberStatus) => Promise<void>;
  /** Closes the app (and releases the instance claim if taken). The pg fixture is the caller's. */
  close: () => Promise<void>;
}

let userSeq = 0;

export async function buildGoogleApp(opts: GoogleAppOptions): Promise<GoogleTestApp> {
  const db = opts.pg.handle.db;
  const boot = opts.seed
    ? await (await import('../../src/db/seed.js')).seed(db)
    : await bootstrap(db);
  const config = googleConfig({ DATABASE_URL: opts.pg.url, ...opts.env });
  const idp = opts.idp ?? new MockIdentityProvider();
  const clock = opts.clock ?? new TestClock();
  const app = await buildApp({
    config,
    db,
    bootChecks: opts.bootChecks ?? false,
    rateLimit: opts.rateLimit,
    logStream: opts.logStream,
    overrides: { identityProvider: idp, clock, ...opts.overrides },
  });
  await app.ready();
  const container = app.container;
  const identity = container.identityRepo;
  const workspaceId = boot.workspaceId;

  const createUser = async (input: CreateUserInput = {}): Promise<TestUser> => {
    const n = ++userSeq;
    const email = input.email ?? `user${n}.${Date.now()}@${TEST_ALLOWED_DOMAIN}`;
    const name = input.name ?? `Test User ${n}`;
    const subject = input.subject ?? `google-sub-${n}-${randomBytes(4).toString('hex')}`;
    const role = input.role ?? 'member';
    const now = clock.now();
    const { user } = await identity.users.upsertBySub({ subject, email, name, avatarUrl: null }, now);
    await identity.memberships.ensureMember(workspaceId, user.id, role, now);
    if (input.status && input.status !== 'active') {
      await identity.memberships.setStatus(workspaceId, user.id, input.status, { by: null, at: now });
    }
    return { userId: user.id, email, name, subject, role };
  };

  const signIn = async (user: Pick<TestUser, 'userId'>): Promise<SessionCredential> => {
    const sessionId = newSessionId();
    await identity.sessions.create({
      idHash: sha256Hex(sessionId),
      userId: user.userId,
      workspaceId,
      now: clock.now(),
    });
    return { cookie: `${SESSION_COOKIE}=${sessionId}`, sessionId };
  };

  const createToken = async (
    user: Pick<TestUser, 'userId'>,
    tokenOpts: { days?: number; name?: string } = {},
  ): Promise<TokenCredential> => {
    const t = newApiToken();
    const now = clock.now();
    const rec = await identity.apiTokens.create({
      userId: user.userId,
      workspaceId,
      name: tokenOpts.name ?? 'test token',
      tokenHash: t.hash,
      prefix: t.prefix,
      now,
      expiresAt: new Date(now.getTime() + (tokenOpts.days ?? 90) * 86_400_000),
    });
    return { authorization: `Bearer ${t.value}`, token: t.value, tokenId: rec.id };
  };

  return {
    app,
    container,
    config,
    db,
    idp,
    clock,
    workspaceId,
    systemUserId: boot.userId,
    createUser,
    signIn,
    createToken,
    setRole: async (user, role) => {
      await identity.memberships.setRole(workspaceId, user.userId, role);
    },
    setStatus: async (user, status) => {
      await identity.memberships.setStatus(workspaceId, user.userId, status, { by: null, at: clock.now() });
    },
    close: () => app.close(),
  };
}
