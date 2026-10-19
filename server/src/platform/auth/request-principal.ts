/**
 * `req.principal` — who is calling, set by the auth guard (`./guard.ts`).
 *
 * - google mode: the guard resolves it on every request to a classified,
 *   non-public route BEFORE any handler runs. Public routes leave it `null`
 *   unless their policy entry opts into `optionalPrincipal`.
 * - local mode: the guard is not installed; it stays `null` and
 *   `getContext()` falls back to `container.auth` (the seeded system user,
 *   exactly as before multi-user mode).
 *
 * Presentation ring only (Fastify typing). Services receive plain arguments
 * (`userId`, `role`) from `getContext()`, never the request.
 */
import type { FastifyInstance } from 'fastify';
import type { Principal } from '@devdigest/shared';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

/** Register the `principal` request decorator (null until the guard sets it). */
export function decorateRequestPrincipal(app: FastifyInstance): void {
  if (!app.hasRequestDecorator('principal')) app.decorateRequest('principal', null);
}
