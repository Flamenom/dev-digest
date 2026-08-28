/**
 * PR Brief HTTP module (spec `specs/2026-08-27-pr-brief.md`).
 *
 *   GET  /pulls/:id/brief → PrBriefDetail, ALWAYS 200 (Rec-6). A PR with no
 *                           cached brief is `generation.state = 'not_generated'`,
 *                           not a 404 — the deterministic header must render even
 *                           with no content. The intent 404 pattern is
 *                           deliberately NOT followed here.
 *   POST /pulls/:id/brief → synchronous regeneration (exactly one structured
 *                           model call) returning the same PrBriefDetail shape.
 *
 * Thin by construction: tenancy first via `getContext`, then one service call.
 * The use case — gathering, grounding, staleness, persistence — lives in
 * `brief/service.ts`; this file only translates HTTP.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';

export default async function briefRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;
  const service = container.briefService;

  // Cached read: no model call, no write, no billing (NFR-2, NFR-4) — so no
  // per-route rate limit beyond the global one.
  app.get('/pulls/:id/brief', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(container, req);
    return service.get(workspaceId, req.params.id);
  });

  // Tight per-route limit: each call is an LLM call.
  app.post(
    '/pulls/:id/brief',
    { schema: { params: IdParams }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.regenerate(workspaceId, req.params.id, req.log);
    },
  );
}
