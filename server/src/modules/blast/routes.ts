/**
 * Blast Radius HTTP module (L04).
 *
 *   GET /pulls/:id/blast → BlastResponse (what this PR's changes can impact:
 *                          symbols → callers → endpoints/crons + prior PRs;
 *                          computed on read from the repo-intel persistent
 *                          index — deterministic, no LLM, no persistence)
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';

export default async function blastRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;
  const service = container.blastService;

  app.get('/pulls/:id/blast', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(container, req);
    return service.get(workspaceId, req.params.id);
  });
}
