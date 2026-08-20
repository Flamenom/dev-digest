/**
 * Conventions Extractor HTTP module.
 *
 *   GET   /repos/:id/conventions          → ConventionListResponse (stats nullish before first scan)
 *   POST  /repos/:id/conventions/extract  → ConventionExtractResponse (synchronous 2-call LLM flow)
 *   PATCH /repos/:id/conventions          → { updated } (bulk status — powers "Deselect all")
 *   PATCH /conventions/:id                → Convention (status accept/reject and/or rule edit)
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BulkConventionStatusBody, UpdateConventionBody } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { NotFoundError } from '../../platform/errors.js';
import { ConventionsService } from './service.js';

export default async function conventionsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;
  const service = new ConventionsService(container);

  app.get('/repos/:id/conventions', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(container, req);
    return service.list(workspaceId, req.params.id);
  });

  app.post('/repos/:id/conventions/extract', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(container, req);
    return service.extract(workspaceId, req.params.id);
  });

  app.patch(
    '/repos/:id/conventions',
    { schema: { params: IdParams, body: BulkConventionStatusBody } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.bulkStatus(workspaceId, req.params.id, req.body.status);
    },
  );

  app.patch(
    '/conventions/:id',
    { schema: { params: IdParams, body: UpdateConventionBody } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      const updated = await service.update(workspaceId, req.params.id, req.body);
      if (!updated) throw new NotFoundError('Convention not found');
      return updated;
    },
  );
}
