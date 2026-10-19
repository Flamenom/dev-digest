import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { ExternalServiceError, NotFoundError } from '../../platform/errors.js';

/**
 * F1 — polling module. MANUAL refresh that ONLY syncs the PR list
 * (new/updated PRs appear, head_sha updates). It does NOT trigger any review —
 * review is manual (user presses Run Review, owned by A2).
 *
 *   POST /repos/:id/poll  → sync the PR list (repo's own provider), bump last_polled_at
 *
 * The sync goes through the container's single-flight `prSync` coordinator
 * (manual = bypasses TTL, joins a running sync), and this endpoint awaits it —
 * so a poll never races a sync-on-open into a second host fetch.
 */
export default async function pollingRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;

  app.post('/repos/:id/poll', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(container, req);
    const repo = await container.pullsReadRepo.findRepoForWorkspace(workspaceId, req.params.id);
    if (!repo) throw new NotFoundError('Repo not found');

    container.prSync.manual(repo);
    const done = await container.prSync.awaitRunning(repo.id);
    if (done?.state === 'failed') {
      throw new ExternalServiceError(done.last_sync_error ?? 'PR list sync failed');
    }

    // `synced` = PRs the repo has open after the sync (the sync service does
    // not report a write count through the coordinator).
    const scope = { workspaceId, repoId: repo.id };
    const synced = (await container.pullRequestRepo.listOpenNumbers(scope)).length;
    await container.pullsReadRepo.markRepoPolled(workspaceId, repo.id, new Date());

    // NOTE: no review is triggered here — manual trigger only.
    return { synced, reviewTriggered: false };
  });
}
