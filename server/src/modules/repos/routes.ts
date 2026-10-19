import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { MAX_REPO_URL_LENGTH } from './constants.js';

/**
 * F1 — repos module. Transport layer only: parses requests, maps status
 * codes, and delegates all business logic to the container-wired RepoService.
 *   POST   /repos              → add repo (github.com | gitlab.com URL; parse, dedupe, persist, enqueue clone)
 *   GET    /repos              → list repos (workspace-scoped)
 *   POST   /repos/:id/refresh  → re-fetch clone + bump last_polled_at
 *   DELETE /repos/:id          → remove repo
 *
 * The clone runs as a JobRunner job (kind 'clone') — real `git clone` via the
 * GitClient adapter into <cloneDir>/<owner>/<repo> (GitHub) or
 * <cloneDir>/@gitlab.com/<namespace…>/<project> (GitLab). Responses are `RepoWithHost`.
 */
/**
 * Add-repo body. Deliberately NOT the shared `RepoInput` (`z.string().url()`):
 * that rejects the scp-like SSH form `git@gitlab.com:<path>.git`, which AC-8
 * requires. The real validation (host allowlist, path safety) is
 * `parseRepoUrlHost` in the service; this only bounds the untrusted string.
 */
const AddRepoBody = z.object({
  url: z.string().trim().min(1).max(MAX_REPO_URL_LENGTH),
});

export default async function reposRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = app.container.repoService;

  // Register the clone job handler once.
  service.registerCloneJobHandler();

  app.post('/repos', { schema: { body: AddRepoBody } }, async (req, reply) => {
    const { workspaceId, userId } = await getContext(app.container, req);
    const { repo, created } = await service.add(workspaceId, userId, req.body.url);
    reply.status(created ? 201 : 200);
    return repo;
  });

  app.get('/repos', async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return service.list(workspaceId);
  });

  app.post('/repos/:id/refresh', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return service.refresh(workspaceId, req.params.id);
  });

  app.delete('/repos/:id', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    await service.remove(workspaceId, req.params.id);
    return { deleted: req.params.id };
  });
}
