import { sql } from 'drizzle-orm';
import type { PrMeta } from '@devdigest/shared';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';

/**
 * Persist a GitHub PR list for one repo — ONE implementation, shared by the
 * list read (`GET /repos/:id/pulls`, auto-sync) and the manual poll
 * (`POST /repos/:id/poll`) so the two paths cannot drift apart.
 *
 * A single multi-row `INSERT … ON CONFLICT (repo_id, number) DO UPDATE` instead
 * of one round-trip per PR. On conflict only the fields GitHub can change on an
 * open PR are refreshed; `additions/deletions/files_count` are NOT overwritten
 * (the list payload carries zeros — real stats come from the detail backfill),
 * and `opened_at` / `author` / `branch` / `base` keep their first-seen values.
 *
 * Returns the number of PRs written.
 */
export async function upsertPullRequestList(
  db: Db,
  scope: { workspaceId: string; repoId: string },
  pulls: readonly PrMeta[],
): Promise<number> {
  if (pulls.length === 0) return 0;
  await db
    .insert(t.pullRequests)
    .values(
      pulls.map((pr) => ({
        workspaceId: scope.workspaceId,
        repoId: scope.repoId,
        number: pr.number,
        title: pr.title,
        author: pr.author,
        branch: pr.branch,
        base: pr.base,
        headSha: pr.head_sha,
        additions: pr.additions,
        deletions: pr.deletions,
        filesCount: pr.files_count,
        status: pr.status,
        openedAt: pr.opened_at ? new Date(pr.opened_at) : null,
        updatedAt: pr.updated_at ? new Date(pr.updated_at) : null,
      })),
    )
    .onConflictDoUpdate({
      target: [t.pullRequests.repoId, t.pullRequests.number],
      set: {
        title: sql`excluded.title`,
        headSha: sql`excluded.head_sha`,
        status: sql`excluded.status`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
  return pulls.length;
}
