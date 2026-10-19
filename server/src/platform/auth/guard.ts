/**
 * Auth guard — the deny-by-default edge of google mode (AC-28, AC-29, AC-50,
 * AC-54, AC-57; plan T21). Presentation ring: Fastify hooks only; every
 * decision comes from the pure `route-policy.ts` + `csrf.ts`.
 *
 * `installAuthGuard` adds ROOT hooks, so it must run BEFORE the feature
 * modules register (root hooks registered first apply to every encapsulated
 * module plugin) and before `@fastify/rate-limit` (whose per-route hooks then
 * see `req.principal` in their key generator):
 *
 *  - `onRequest` (no body yet): look up the policy of the MATCHED route
 *    (`req.routeOptions.url`; undefined → 404, left alone), resolve the
 *    principal, then in order: 401 `unauthenticated` → 403 `csrf_rejected`
 *    (session mutations) → 403 `session_required` (static) → 403
 *    `forbidden_role`. Only then is `req.principal` set and the handler
 *    allowed to run — SSE streams included (they open in the handler).
 *  - `preHandler` (body parsed + validated): body-dependent `sessionOnly`
 *    predicates (test-connection WITH a key, AC-57).
 *
 * Failed-credential 401s (a bearer / session cookie was presented but did
 * not resolve) are charged to a per-address {@link RejectionLimiter}
 * (`@fastify/rate-limit`'s route-level hook never sees a request rejected
 * here); once over budget such requests get 429 after the single principal
 * lookup. A request that resolves to a valid principal is never blocked.
 *
 * Fail closed: a resolver error is logged (message only — never a header)
 * and answered 503 `auth_unavailable`; it never falls through to an
 * anonymous or system-user context.
 *
 * `installRoutePolicyHooks` (both modes) records every registered route for
 * the policy-completeness tests and applies `perIpRateLimit` entries.
 */
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RateLimitOptions } from '@fastify/rate-limit';
import type { Principal, PrincipalProvider } from '@devdigest/shared';
import { AppError } from '../errors.js';
import { describeError } from '../errors-describe.js';
import {
  CsrfRejectedError,
  ForbiddenRoleError,
  SessionRequiredError,
  UnauthenticatedError,
} from '../auth-errors.js';
import { passesCsrf } from './csrf.js';
import { lookupPolicy, policyKey } from './route-policy.js';
import { decorateRequestPrincipal } from './request-principal.js';

export class AuthUnavailableError extends AppError {
  constructor() {
    super('auth_unavailable', 'Authentication is temporarily unavailable — try again', 503);
  }
}

export class TooManyRejectedRequestsError extends AppError {
  constructor(retryAfterSeconds: number) {
    super('rate_limited', 'Too many rejected requests from this address — try again later', 429, {
      retry_after_seconds: retryAfterSeconds,
    });
  }
}

/** Per-address budget of failed-credential rejections per window. */
export interface RejectionLimit {
  max: number;
  windowMs: number;
}

/**
 * Default rejection budget: 60 failed-credential requests / minute / address.
 * Below the global 120/min so bearer/cookie guessing is throttled harder than
 * normal traffic, yet a browser with an expired session (a burst of parallel
 * 401s) stays well inside it.
 */
export const DEFAULT_REJECTION_LIMIT: RejectionLimit = Object.freeze({ max: 60, windowMs: 60_000 });

/** Cap on tracked addresses — a spoof-free flood can't grow the map without bound. */
const MAX_TRACKED_IPS = 10_000;

/**
 * The limiter bucket for a client address: an IPv4 address as is (an
 * IPv4-mapped IPv6 address is folded to its IPv4 form); an IPv6 address by its
 * /64 prefix — one host typically owns a whole /64, so per-address keys would
 * let it rotate through 2^64 buckets. Anything unparseable is used verbatim.
 */
export function rejectionKey(ip: string): string {
  const family = isIP(ip.split('%')[0] ?? ip);
  if (family !== 6) return ip;
  let s = ip.split('%')[0]!.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) return mapped[1]!;
  // A dotted IPv4 tail is always the last 32 bits — irrelevant for a /64.
  s = s.replace(/\d{1,3}(?:\.\d{1,3}){3}$/, '0:0');
  const [head = '', tail] = s.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? headParts
      : [...headParts, ...Array<string>(8 - headParts.length - tailParts.length).fill('0'), ...tailParts];
  const prefix = groups.slice(0, 4).map((g) => parseInt(g || '0', 16).toString(16));
  return `${prefix.join(':')}::/64`;
}

interface RejectionWindow {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window counter of FAILED-CREDENTIAL rejections per client address
 * (see {@link rejectionKey}). `@fastify/rate-limit` runs as a route-level hook,
 * i.e. AFTER this root guard, so a request the guard rejects never reaches it;
 * without this, bearer/cookie guessing was unlimited.
 *
 * Only a presented-but-unresolvable credential is charged, and the block only
 * applies to such requests — a valid principal is never blocked, and nothing a
 * cross-site page can make a victim's browser send (CSRF-failing or
 * anonymous requests) counts, so the limiter can't be turned into a lockout.
 *
 * Memory bound: at `capacity` an amortised sweep frees ~10% of the slots —
 * expired windows first, then the lowest-count entries that are NOT over
 * budget. An over-budget window is never evicted before it expires; if every
 * slot is over budget, a new address is simply not tracked until one expires.
 */
export class RejectionLimiter {
  private readonly windows = new Map<string, RejectionWindow>();

  constructor(
    private readonly limit: RejectionLimit,
    private readonly now: () => number = Date.now,
    private readonly capacity: number = MAX_TRACKED_IPS,
  ) {}

  /** Number of tracked addresses (tests). */
  get size(): number {
    return this.windows.size;
  }

  /** Seconds until the window resets when `key` is over budget, else null. */
  blockedFor(key: string): number | null {
    const w = this.windows.get(key);
    if (!w) return null;
    const now = this.now();
    if (w.resetAt <= now) {
      this.windows.delete(key);
      return null;
    }
    return w.count >= this.limit.max ? Math.max(1, Math.ceil((w.resetAt - now) / 1000)) : null;
  }

  hit(key: string): void {
    const now = this.now();
    const w = this.windows.get(key);
    if (w && w.resetAt > now) {
      w.count++;
      return;
    }
    if (w) this.windows.delete(key);
    if (this.windows.size >= this.capacity) {
      this.sweep(now);
      if (this.windows.size >= this.capacity) return; // every slot is over budget
    }
    this.windows.set(key, { count: 1, resetAt: now + this.limit.windowMs });
  }

  /** Free slots down to 90% of capacity; O(n log n), run once per ~10% of capacity inserts. */
  private sweep(now: number): void {
    const target = this.capacity - Math.max(1, Math.floor(this.capacity / 10));
    const evictable: Array<[string, number]> = [];
    for (const [key, w] of this.windows) {
      if (w.resetAt <= now) this.windows.delete(key);
      else if (w.count < this.limit.max) evictable.push([key, w.count]);
    }
    if (this.windows.size <= target) return;
    evictable.sort((a, b) => a[1] - b[1]);
    for (const [key] of evictable) {
      if (this.windows.size <= target) break;
      this.windows.delete(key);
    }
  }
}

export interface AuthGuardDeps {
  /** Resolved lazily per request (the container getter is lazy). */
  principals: () => PrincipalProvider;
  /** `config.publicOrigin` — the only origin a cookie mutation may come from. */
  publicOrigin: string;
  /** Name of the session cookie — its presence marks a request as carrying a credential. */
  sessionCookie: string;
  /**
   * Per-address limit on failed-credential requests; null/absent disables it
   * (rate limiting off, e.g. under test). See {@link RejectionLimiter}.
   */
  rejectionLimit?: RejectionLimit | null;
}

/**
 * True when the request PRESENTS a credential: a `Bearer` authorization or the
 * session cookie (by name; the value may be anything). Anonymous requests
 * (signed-out probes) carry neither and are never charged.
 */
function presentsCredential(req: FastifyRequest, sessionCookie: string): boolean {
  const auth = req.headers.authorization;
  const auths = Array.isArray(auth) ? auth : auth === undefined ? [] : [auth];
  if (auths.some((v) => /^bearer\b/i.test(v.trim()))) return true;
  const cookie = req.headers.cookie;
  if (typeof cookie !== 'string') return false;
  return cookie.split(';').some((part) => {
    const eq = part.indexOf('=');
    return eq >= 0 && part.slice(0, eq).trim() === sessionCookie;
  });
}

async function resolvePrincipal(
  req: FastifyRequest,
  principals: () => PrincipalProvider,
): Promise<Principal | null> {
  try {
    return await principals().resolve(req);
  } catch (err) {
    req.log.error(describeError(err), 'principal resolution failed — request denied');
    throw new AuthUnavailableError();
  }
}

/** Install the google-mode guard. Call once, on the root instance, before any module registers. */
export function installAuthGuard(app: FastifyInstance, deps: AuthGuardDeps): void {
  decorateRequestPrincipal(app);

  const limiter = deps.rejectionLimit ? new RejectionLimiter(deps.rejectionLimit) : null;

  app.addHook('onRequest', async (req, reply) => {
    const url = req.routeOptions.url;
    if (url === undefined) return; // no matching route → Fastify answers 404
    const { policy } = lookupPolicy(req.method, url);

    if (policy.access === 'public') {
      // Public routes don't reject here, so the route-level limiter sees them.
      if (policy.optionalPrincipal) req.principal = await resolvePrincipal(req, deps.principals);
      return;
    }

    const principal = await resolvePrincipal(req, deps.principals);
    if (!principal) {
      // Only a presented-but-failed credential is charged / blocked: a valid
      // principal is never locked out, and anonymous probes never count.
      if (limiter && presentsCredential(req, deps.sessionCookie)) {
        const key = rejectionKey(req.ip);
        const retryAfter = limiter.blockedFor(key);
        if (retryAfter !== null) {
          reply.header('retry-after', String(retryAfter));
          throw new TooManyRejectedRequestsError(retryAfter);
        }
        limiter.hit(key);
      }
      throw new UnauthenticatedError();
    }
    if (principal.via === 'session' && !passesCsrf(req.method, req.headers, deps.publicOrigin)) {
      throw new CsrfRejectedError();
    }
    if (principal.via === 'token' && policy.sessionOnly === true) throw new SessionRequiredError();
    if (policy.access === 'admin' && principal.role !== 'admin') throw new ForbiddenRoleError();
    req.principal = principal;
  });

  app.addHook('preHandler', async (req) => {
    if (req.principal?.via !== 'token') return;
    const url = req.routeOptions.url;
    if (url === undefined) return;
    const { sessionOnly } = lookupPolicy(req.method, url).policy;
    if (typeof sessionOnly === 'function' && sessionOnly({ body: req.body })) {
      throw new SessionRequiredError();
    }
  });
}

const registered = new WeakMap<FastifyInstance, Set<string>>();

/**
 * Every route registered on `app` so far, as policy keys (`'GET /repos'`;
 * HEAD folded into GET). Populated by {@link installRoutePolicyHooks}.
 */
export function registeredRouteKeys(app: FastifyInstance): string[] {
  return [...(registered.get(app) ?? [])].sort();
}

/**
 * Root `onRoute` hook (both modes): collect route keys, and give routes with a
 * `perIpRateLimit` policy a per-IP limit (AC-53). Must be added BEFORE
 * `@fastify/rate-limit` registers so its own `onRoute` sees the config.
 */
export function installRoutePolicyHooks(app: FastifyInstance): void {
  const keys = new Set<string>();
  registered.set(app, keys);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      keys.add(policyKey(method, route.url));
      const { perIpRateLimit } = lookupPolicy(method, route.url).policy;
      if (perIpRateLimit) {
        const rateLimit = {
          ...perIpRateLimit,
          keyGenerator: (req: FastifyRequest) => `ip:${req.ip}`,
        } satisfies RateLimitOptions;
        // `rateLimit` is typed on FastifyContextConfig by @fastify/rate-limit's
        // module augmentation, so a shape mismatch fails typecheck here.
        route.config = { ...(route.config ?? {}), rateLimit };
      }
    }
  });
}

/** Global rate-limit key (AC-53): per user when authenticated, else per IP. */
export function rateLimitKey(req: FastifyRequest): string {
  return req.principal ? `u:${req.principal.userId}` : `ip:${req.ip}`;
}
