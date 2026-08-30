import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SaveDocumentBody } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { ProjectContextService } from './service.js';

/**
 * Project Context module — discovery + guarded read/save of a repo's project
 * documents (specs / docs / insights) in its clone working tree.
 *   GET /repos/:repoId/project-context                 → { documents, summary }
 *   GET /repos/:repoId/project-context/document?path=… → DocumentContent
 *   PUT /repos/:repoId/project-context/document        → DocumentContent (save)
 *
 * Error mapping (global handler): missing repo/document → 404 (NotFoundError);
 * path-guard violation (traversal / absolute / symlink escape) → 422
 * (ValidationError).
 */

const RepoIdParams = z.object({ repoId: z.string().uuid() });

/** The document is addressed by its repo-relative path in the query string. */
const DocumentQuery = z.object({ path: z.string().min(1) });

export default async function projectContextRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new ProjectContextService(app.container);

  app.get(
    '/repos/:repoId/project-context',
    { schema: { params: RepoIdParams } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.listForRepo(workspaceId, req.params.repoId);
    },
  );

  app.get(
    '/repos/:repoId/project-context/document',
    { schema: { params: RepoIdParams, querystring: DocumentQuery } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.readDocument(workspaceId, req.params.repoId, req.query.path);
    },
  );

  app.put(
    '/repos/:repoId/project-context/document',
    { schema: { params: RepoIdParams, body: SaveDocumentBody } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.saveDocument(workspaceId, req.params.repoId, req.body.path, req.body.text);
    },
  );
}
