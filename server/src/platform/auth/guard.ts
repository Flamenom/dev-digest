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
 * Rejections (401/403) are charged to a per-IP {@link RejectionLimiter}
 * (`@fastify/rate-limit`'s route-level hook never sees a request rejected
 * here); an address over budget gets 429 before any principal lookup.
 *
 * Fail closed: a resolver error is logged (message only — never a header)
 * and answered 503 `auth_unavailable`; it never falls through to an
 * anonymous or system-user context.
 *
 * `installRoutePolicyHooks` (both modes) records every registered route for
 * the policy-completeness tests and applies `perIpRateLimit` entries.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Principal, PrincipalProvider } from '@devdigest/shared';
import { AppError } from '../errors.js';
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

/** Per-IP budget of guard rejections (401/403) per window. */
export interface RejectionLimit {
  max: number;
  windowMs: number;
}

/**
 * Default rejection budget: 60 denied requests / minute / IP. Below the global
 * 120/min so bearer/cookie guessing is throttled harder than normal traffic,
 * yet a browser with an expired session (a burst of parallel 401s) stays well
 * inside it.
 */
export const DEFAULT_REJECTION_LIMIT: RejectionLimit = Object.freeze({ max: 60, windowMs: 60_000 });

/** Cap on tracked addresses — a spoof-free flood can't grow the map without bound. */
const MAX_TRACKED_IPS = 10_000;

/**
 * Fixed-window counter of guard REJECTIONS per client IP. `@fastify/rate-limit`
 * runs as a route-level hook, i.e. AFTER this root guard, so a request the
 * guard rejects never reaches it; without this, 401 floods / token guessing
 * were unlimited and each cost a principal lookup. Checked BEFORE resolving
 * the principal, so a blocked address costs no lookup at all. Authenticated,
 * accepted requests never count here — they stay on the per-user budget.
 */
export class RejectionLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: RejectionLimit,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds until the window resets when `ip` is over budget, else null. */
  blockedFor(ip: string): number | null {
    const w = this.windows.get(ip);
    const now = this.now();
    if (!w || w.resetAt <= now) return null;
    return w.count >= this.limit.max ? Math.max(1, Math.ceil((w.resetAt - now) / 1000)) : null;
  }

  hit(ip: string): void {
    const now = this.now();
    const w = this.windows.get(ip);
    if (w && w.resetAt > now) {
      w.count++;
      return;
    }
    if (this.windows.size >= MAX_TRACKED_IPS) this.evict(now);
    this.windows.set(ip, { count: 1, resetAt: now + this.limit.windowMs });
  }

  private evict(now: number): void {
    for (const [ip, w] of this.windows) if (w.resetAt <= now) this.windows.delete(ip);
    // Still full → drop the oldest window (Map keeps insertion order).
    if (this.windows.size >= MAX_TRACKED_IPS) {
      const oldest = this.windows.keys().next().value;
      if (oldest !== undefined) this.windows.delete(oldest);
    }
  }
}

export interface AuthGuardDeps {
  /** Resolved lazily per request (the container getter is lazy). */
  principals: () => PrincipalProvider;
  /** `config.publicOrigin` — the only origin a cookie mutation may come from. */
  publicOrigin: string;
  /**
   * Per-IP limit on rejected requests; null/absent disables it (rate limiting
   * off, e.g. under test). See {@link RejectionLimiter}.
   */
  rejectionLimit?: RejectionLimit | null;
}

/** 401/403 from the guard count against the address; 503 (our outage) does not. */
function countsAsRejection(err: unknown): boolean {
  const status = (err as { statusCode?: unknown })?.statusCode;
  return status === 401 || status === 403;
}

async function resolvePrincipal(
  req: FastifyRequest,
  principals: () => PrincipalProvider,
): Promise<Principal | null> {
  try {
    return await principals().resolve(req);
  } catch (err) {
    req.log.error({ err: (err as Error)?.message }, 'principal resolution failed — request denied');
    throw new AuthUnavailableError();
  }
}

/** Install the google-mode guard. Call once, on the root instance, before any module registers. */
export function installAuthGuard(app: FastifyInstance, deps: AuthGuardDeps): void {
  decorateRequestPrincipal(app);

  const limiter = deps.rejectionLimit ? new RejectionLimiter(deps.rejectionLimit) : null;

  /** Run a guard check; a 401/403 it throws is charged to the client address. */
  const charged = async (req: FastifyRequest, check: () => Promise<void>): Promise<void> => {
    try {
      await check();
    } catch (err) {
      if (limiter && countsAsRejection(err)) limiter.hit(req.ip);
      throw err;
    }
  };

  app.addHook('onRequest', async (req, reply) => {
    const url = req.routeOptions.url;
    if (url === undefined) return; // no matching route → Fastify answers 404
    const { policy } = lookupPolicy(req.method, url);

    if (policy.access === 'public') {
      // Public routes don't reject here, so the route-level limiter sees them.
      if (policy.optionalPrincipal) req.principal = await resolvePrincipal(req, deps.principals);
      return;
    }

    // Over the rejection budget → 429 before any principal lookup.
    const retryAfter = limiter?.blockedFor(req.ip) ?? null;
    if (retryAfter !== null) {
      reply.header('retry-after', String(retryAfter));
      throw new TooManyRejectedRequestsError(retryAfter);
    }

    await charged(req, async () => {
      const principal = await resolvePrincipal(req, deps.principals);
      if (!principal) throw new UnauthenticatedError();
      if (principal.via === 'session' && !passesCsrf(req.method, req.headers, deps.publicOrigin)) {
        throw new CsrfRejectedError();
      }
      if (principal.via === 'token' && policy.sessionOnly === true) throw new SessionRequiredError();
      if (policy.access === 'admin' && principal.role !== 'admin') throw new ForbiddenRoleError();
      req.principal = principal;
    });
  });

  app.addHook('preHandler', async (req) => {
    if (req.principal?.via !== 'token') return;
    const url = req.routeOptions.url;
    if (url === undefined) return;
    const { sessionOnly } = lookupPolicy(req.method, url).policy;
    if (typeof sessionOnly === 'function' && sessionOnly({ body: req.body })) {
      limiter?.hit(req.ip);
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
        route.config = {
          ...(route.config ?? {}),
          rateLimit: {
            ...perIpRateLimit,
            keyGenerator: (req: FastifyRequest) => `ip:${req.ip}`,
          },
        } as typeof route.config;
      }
    }
  });
}

/** Global rate-limit key (AC-53): per user when authenticated, else per IP. */
export function rateLimitKey(req: FastifyRequest): string {
  return req.principal ? `u:${req.principal.userId}` : `ip:${req.ip}`;
}
