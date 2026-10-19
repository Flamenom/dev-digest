import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApiTokenCreateInput, MemberUpdate } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { AppError } from '../../platform/errors.js';
import { AuthDisabledError, AuthFlowError } from '../../platform/auth-errors.js';
import { safeReturnTo } from '../../platform/auth/return-to.js';
import { sessionCookieValue } from './principal-service.js';
import {
  memberListToDto,
  memberToDto,
  oauthBindingCookie,
  postSignInLocation,
  queryString,
  sessionCookie,
  signInErrorLocation,
  toCurrentSession,
} from './helpers.js';

/**
 * Identity module — sign-in, session, members, personal API tokens
 * (spec SPEC-2026-10-19-multi-user-server; plan T22, Q6).
 *
 *   GET    /auth/google/start?return_to=  → 302 to Google + `__Host-ddg_oauth` binding cookie
 *   GET    /auth/google/callback          → session cookie + 302 to `<origin><return_to>`,
 *                                            or 302 to `<origin>/sign-in?error=<code>`
 *   GET    /auth/session                  → CurrentSession (google: 401 when signed out,
 *                                            `details.allowed_domain`); local: the system user
 *   POST   /auth/sign-out                 → { ok: true } + cleared cookie (session only)
 *   GET    /members                       → MemberList
 *   PATCH  /members/:userId               → Member (Admin, session only)
 *   GET    /tokens                        → ApiTokenListItem[] (own; bare array)
 *   POST   /tokens                        → 201 ApiTokenCreated (value shown once)
 *   DELETE /tokens/:id                    → 204 (own, or any as Admin)
 *
 * Authorization lives in the central route policy (`platform/auth/route-policy.ts`)
 * enforced by the google-mode guard; the services re-check (defense in depth).
 * The per-IP sign-in rate limit is applied from the policy too.
 *
 * Local mode: the Google routes, sign-out and tokens answer 404 `auth_disabled`;
 * `/auth/session` and `/members` work (the system user is Admin).
 *
 * Secrets discipline: `code`, `state`, cookie values and token values are never
 * logged or echoed. The callback route logs at `warn` so the default request
 * log line (which carries the URL query) is not written for it.
 */

const StartQuery = z.object({
  // Untrusted; `safeReturnTo` turns anything but a same-origin path into `/` (AC-16).
  return_to: z.unknown().optional(),
});

// Only `code` and `state` are read. Any other query (`hd`, `email`, `role`, …) is stripped (AC-10).
const CallbackQuery = z.object({
  code: z.unknown().optional(),
  state: z.unknown().optional(),
});

const MemberParams = z.object({ userId: z.string().uuid() });

const NO_STORE = 'no-store';

export default async function identityRoutes(app: FastifyInstance) {
  const { container } = app;
  const r = app.withTypeProvider<ZodTypeProvider>();
  const config = container.config;
  const google = config.authMode === 'google';
  const publicOrigin = config.publicOrigin ?? config.webOrigin;

  const requireGoogle = () => {
    if (!google) throw new AuthDisabledError();
  };

  /** AC-62: cookies are only ever set on an HTTPS request (via the trusted proxy). */
  const refuseInsecure = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.protocol === 'https') return false;
    req.log.warn('sign-in reached over plain HTTP — no cookie set (check TRUST_PROXY / the proxy)');
    reply.header('cache-control', NO_STORE).redirect(signInErrorLocation(publicOrigin, 'auth_state_invalid'));
    return true;
  };

  // ── Sign-in ─────────────────────────────────────────────────────────────────

  r.get('/auth/google/start', { schema: { querystring: StartQuery } }, async (req, reply) => {
    requireGoogle();
    if (refuseInsecure(req, reply)) return reply;
    const signIn = await container.signIn();
    const { authorizationUrl, bindingValue } = await signIn.start({
      returnTo: safeReturnTo(req.query.return_to),
    });
    reply.setCookie(oauthBindingCookie.name, bindingValue, oauthBindingCookie.set());
    return reply.header('cache-control', NO_STORE).redirect(authorizationUrl);
  });

  r.get(
    '/auth/google/callback',
    { schema: { querystring: CallbackQuery }, logLevel: 'warn' },
    async (req, reply) => {
      requireGoogle();
      if (refuseInsecure(req, reply)) return reply;
      const signIn = await container.signIn();
      reply.header('cache-control', NO_STORE);
      // The flow is single-use: the binding cookie is spent either way.
      reply.setCookie(oauthBindingCookie.name, '', oauthBindingCookie.clear());
      try {
        const result = await signIn.callback({
          code: queryString(req.query.code),
          state: queryString(req.query.state),
          bindingValue: req.cookies[oauthBindingCookie.name],
          previousSessionValue: sessionCookieValue(req),
          ip: req.ip,
        });
        reply.setCookie(sessionCookie.name, result.sessionValue, sessionCookie.set());
        return reply.redirect(postSignInLocation(publicOrigin, result.returnTo));
      } catch (err) {
        if (!(err instanceof AuthFlowError)) throw err;
        return reply.redirect(signInErrorLocation(publicOrigin, err.flowCode));
      }
    },
  );

  // ── Session ─────────────────────────────────────────────────────────────────

  r.get('/auth/session', async (req, reply) => {
    reply.header('cache-control', NO_STORE);
    if (!google) {
      const [user, workspace] = await Promise.all([
        container.auth.currentUser(req),
        container.auth.currentWorkspace(req),
      ]);
      return toCurrentSession({
        mode: 'local',
        user: { ...user, avatarUrl: null },
        role: 'admin',
        workspace,
      });
    }

    const signedOut = () =>
      new AppError('unauthenticated', 'Authentication required', 401, {
        allowed_domain: config.allowedDomain,
      });
    const principal = req.principal;
    if (!principal) throw signedOut();
    const [user, workspace] = await Promise.all([
      container.identityRepo.users.findById(principal.userId),
      container.auth.currentWorkspace(req),
    ]);
    if (!user) throw signedOut();
    return toCurrentSession({
      mode: 'google',
      user,
      role: principal.role,
      workspace: { id: principal.workspaceId, name: workspace.name },
      allowedDomain: config.allowedDomain,
    });
  });

  r.post('/auth/sign-out', async (req, reply) => {
    requireGoogle();
    const ctx = await getContext(container, req);
    const signIn = await container.signIn();
    await signIn.signOut({
      sessionValue: sessionCookieValue(req),
      actorUserId: ctx.userId,
      ip: req.ip,
    });
    reply.setCookie(sessionCookie.name, '', sessionCookie.clear());
    return { ok: true as const };
  });

  // ── Members ─────────────────────────────────────────────────────────────────

  r.get('/members', async (req) => {
    const { workspaceId } = await getContext(container, req);
    return memberListToDto(await container.members.list(workspaceId));
  });

  r.patch(
    '/members/:userId',
    { schema: { params: MemberParams, body: MemberUpdate } },
    async (req) => {
      const ctx = await getContext(container, req);
      const member = await container.members.update({ ...ctx, ip: req.ip }, req.params.userId, req.body);
      return memberToDto(member);
    },
  );

  // ── Personal API tokens (google mode) ─────────────────────────────────────────

  r.get('/tokens', async (req) => {
    requireGoogle();
    const ctx = await getContext(container, req);
    return container.tokens.list(ctx);
  });

  r.post('/tokens', { schema: { body: ApiTokenCreateInput } }, async (req, reply) => {
    requireGoogle();
    const ctx = await getContext(container, req);
    const created = await container.tokens.create({ ...ctx, ip: req.ip }, req.body);
    return reply.status(201).header('cache-control', NO_STORE).send(created);
  });

  r.delete('/tokens/:id', { schema: { params: IdParams } }, async (req, reply) => {
    requireGoogle();
    const ctx = await getContext(container, req);
    await container.tokens.revoke({ ...ctx, ip: req.ip }, req.params.id);
    return reply.status(204).send();
  });
}
