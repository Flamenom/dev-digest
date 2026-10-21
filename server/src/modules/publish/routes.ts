import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { OtherDraftsCount, Publication, PublishPreview } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { lookupPolicy, roleSatisfies } from '../../platform/auth/route-policy.js';

/**
 * publish module — publish review findings to a GitLab MR as one batch review
 * (spec `specs/2026-10-21-gitlab-publish-findings.md`; plan T10). Presentation
 * only: tenancy via `getContext`, one `container.publishService` call per route.
 *
 *   GET  /reviews/:id/publish-preview       → PublishPreview (0 GitLab requests, AC-2)
 *   GET  /reviews/:id/publish-other-drafts  → OtherDraftsCount (one list read, AC-38)
 *   POST /reviews/:id/publications          → 202 Publication (in progress, AC-21)
 *   GET  /reviews/:id/publications          → Publication[] (newest first)
 *   GET  /publications/:id                  → Publication
 *
 * Every `:id` is a row uuid. Permission rows live in `platform/auth/route-policy.ts`.
 */

/** The ONE policy row that gates publishing (AC-40) — also drives `viewer_can_publish`. */
const PUBLISH_ROUTE = { method: 'POST', url: '/reviews/:id/publications' } as const;

export default async function publishRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;

  app.get(
    '/reviews/:id/publish-preview',
    { schema: { params: IdParams, response: { 200: PublishPreview } } },
    async (req) => {
      const { workspaceId, role } = await getContext(container, req);
      // Q6: the client's publish affordance follows the SAME table row the guard
      // enforces (local mode: role = admin).
      const access = lookupPolicy(PUBLISH_ROUTE.method, PUBLISH_ROUTE.url).policy.access;
      return container.publishService.preview(workspaceId, req.params.id, roleSatisfies(role, access));
    },
  );

  app.get(
    '/reviews/:id/publish-other-drafts',
    { schema: { params: IdParams, response: { 200: OtherDraftsCount } } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return container.publishService.otherDraftsCount(workspaceId, req.params.id);
    },
  );

  // NO body schema: the service parses the body so AC-20's validation ORDER
  // (review → selection → summary → blockers → findings) and codes hold.
  app.post(
    PUBLISH_ROUTE.url,
    { schema: { params: IdParams, response: { 202: Publication } } },
    async (req, reply) => {
      const { workspaceId, userId } = await getContext(container, req);
      const publication = await container.publishService.create(
        workspaceId,
        req.params.id,
        req.body,
        userId,
      );
      reply.code(202);
      return publication;
    },
  );

  app.get(
    '/reviews/:id/publications',
    { schema: { params: IdParams, response: { 200: z.array(Publication) } } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return container.publishService.listForReview(workspaceId, req.params.id);
    },
  );

  app.get(
    '/publications/:id',
    { schema: { params: IdParams, response: { 200: Publication } } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return container.publishService.get(workspaceId, req.params.id);
    },
  );
}
