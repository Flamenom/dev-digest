import type { FastifyRequest } from 'fastify';
import type { PrincipalVia, Role } from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import { UnauthenticatedError } from '../../platform/auth-errors.js';
import '../../platform/auth/request-principal.js';

export interface RequestContext {
  workspaceId: string;
  userId: string;
  /** The caller's CURRENT role (re-read every request in google mode, AC-27). Local mode: `admin`. */
  role: Role;
  /** How the caller authenticated: `session` / `token` (google) or `local`. */
  via: PrincipalVia;
}

/**
 * Resolve the tenancy + actor context for a request. Every module uses this so
 * workspace scoping is never forgotten, and services receive the actor as
 * plain arguments (`userId`, `role`) — e.g. for AC-30 ownership checks.
 *
 * - google mode: the principal the auth guard resolved (`req.principal`).
 *   A google-mode request without one never falls back to the system user —
 *   it is rejected 401 (fail closed).
 * - local mode: unchanged — the AuthProvider's default workspace + system
 *   user, with the Admin role (AC-2).
 */
export async function getContext(
  container: Container,
  req: FastifyRequest,
): Promise<RequestContext> {
  const principal = req.principal;
  if (principal) {
    return {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      role: principal.role,
      via: principal.via,
    };
  }
  if (container.config.authMode === 'google') throw new UnauthenticatedError();
  const [user, workspace] = await Promise.all([
    container.auth.currentUser(req),
    container.auth.currentWorkspace(req),
  ]);
  return { workspaceId: workspace.id, userId: user.id, role: 'admin', via: 'local' };
}
