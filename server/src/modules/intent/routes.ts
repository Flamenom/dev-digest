/**
 * Intent Layer HTTP module (L03).
 *
 *   GET  /pulls/:id/intent → IntentDetail (404 until first classification)
 *   POST /pulls/:id/intent → synchronous re/classification (one cheap LLM call —
 *                            conventions sync-POST precedent)
 *
 * Derivation itself lives in reviews/intent-deriver.ts (free functions); this
 * module consumes the container's `intent` binding — no sibling-module import.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { NotFoundError } from '../../platform/errors.js';

export default async function intentRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;
  const intent = container.intent;

  app.get('/pulls/:id/intent', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(container, req);
    const detail = await intent.get(workspaceId, req.params.id);
    if (!detail) throw new NotFoundError('Intent not found');
    return detail;
  });

  // Tight per-route limit: each call is an LLM classification.
  app.post(
    '/pulls/:id/intent',
    { schema: { params: IdParams }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return intent.derive(workspaceId, req.params.id, req.log);
    },
  );
}
