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

export interface AuthGuardDeps {
  /** Resolved lazily per request (the container getter is lazy). */
  principals: () => PrincipalProvider;
  /** `config.publicOrigin` — the only origin a cookie mutation may come from. */
  publicOrigin: string;
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

  app.addHook('onRequest', async (req) => {
    const url = req.routeOptions.url;
    if (url === undefined) return; // no matching route → Fastify answers 404
    const { policy } = lookupPolicy(req.method, url);

    if (policy.access === 'public') {
      if (policy.optionalPrincipal) req.principal = await resolvePrincipal(req, deps.principals);
      return;
    }

    const principal = await resolvePrincipal(req, deps.principals);
    if (!principal) throw new UnauthenticatedError();
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
