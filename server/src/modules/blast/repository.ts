/**
 * Blast repository — prior PRs touching the same files. Pure local SQL over
 * `pull_requests` ⋈ `pr_files` (no GitHub calls): PRs in the same repo whose
 * files overlap the current PR's files, latest-updated first, capped.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { BlastPriorPr } from '@devdigest/shared';

/** How many prior PRs the card shows. */
const PRIOR_PRS_LIMIT = 5;

export class BlastRepository {
  constructor(private db: Db) {}

  /**
   * Prior PRs in `repoId` (excluding `prId`) whose files overlap
   * `changedFiles`, with the overlapping paths aggregated per PR.
   * Tenancy: `repoId` comes from the already workspace-checked pull row.
   */
  async getPriorPrs(
    repoId: string,
    prId: string,
    changedFiles: string[],
    limit: number = PRIOR_PRS_LIMIT,
  ): Promise<BlastPriorPr[]> {
    if (changedFiles.length === 0) return [];
    const rows = await this.db
      .select({
        number: t.pullRequests.number,
        title: t.pullRequests.title,
        author: t.pullRequests.author,
        status: t.pullRequests.status,
        filesOverlap: sql<string[]>`array_agg(distinct ${t.prFiles.path})`,
      })
      .from(t.pullRequests)
      .innerJoin(t.prFiles, eq(t.prFiles.prId, t.pullRequests.id))
      .where(
        and(
          eq(t.pullRequests.repoId, repoId),
          ne(t.pullRequests.id, prId),
          inArray(t.prFiles.path, changedFiles),
        ),
      )
      .groupBy(t.pullRequests.id)
      // `updated_at` is nullable — keep never-updated PRs at the end.
      .orderBy(sql`${t.pullRequests.updatedAt} desc nulls last`)
      .limit(limit);

    return rows.map((r) => ({
      number: r.number,
      title: r.title,
      author: r.author,
      status: r.status,
      files_overlap: r.filesOverlap ?? [],
    }));
  }
}
