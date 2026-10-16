import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import * as t from '../../db/schema.js';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { upsertPullRequestList } from '../_shared/repository/pr-sync.js';
import { NotFoundError } from '../../platform/errors.js';

/**
 * F1 — polling module. MANUAL refresh that ONLY syncs the PR list
 * (new/updated PRs appear, head_sha updates). It does NOT trigger any review —
 * review is manual (user presses Run Review, owned by A2).
 *
 *   POST /repos/:id/poll  → sync PR list from GitHub, bump last_polled_at
 */
export default async function pollingRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;

  app.post('/repos/:id/poll', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(container, req);
    const [repo] = await container.db
      .select()
      .from(t.repos)
      .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.id, req.params.id)));
    if (!repo) throw new NotFoundError('Repo not found');

    const gh = await container.github();
    const pulls = await gh.listPullRequests({ owner: repo.owner, name: repo.name });
    const synced = await upsertPullRequestList(container.db, { workspaceId, repoId: repo.id }, pulls);
    await container.db
      .update(t.repos)
      .set({ lastPolledAt: new Date() })
      .where(eq(t.repos.id, repo.id));

    // NOTE: no review is triggered here — manual trigger only.
    return { synced, reviewTriggered: false };
  });
}
