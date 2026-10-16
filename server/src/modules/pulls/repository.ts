import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { PrMeta } from '@devdigest/shared';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

/** The handle Drizzle passes to a `db.transaction(async (tx) => …)` callback. */
export type PullsTx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** What a method runs against — the client, or a caller-owned transaction. */
export type PullsExecutor = Db | PullsTx;

export interface PrScope {
  workspaceId: string;
  repoId: string;
}

export interface DiffStats {
  additions: number;
  deletions: number;
  filesCount: number;
}

/** The `pull_requests` write port — what consumers (and test fakes) depend on. */
export interface PullRequestStore {
  upsertList(scope: PrScope, pulls: readonly PrMeta[], tx?: PullsExecutor): Promise<number>;
  updateDiffStats(workspaceId: string, prId: string, stats: DiffStats, tx?: PullsExecutor): Promise<void>;
}

/** `excluded.<col>` for an ON CONFLICT set — column name taken from the schema, so a rename breaks the build. */
function excluded(column: AnyPgColumn): SQL {
  return sql.raw(`excluded.${column.name}`);
}

/**
 * F1 — `pull_requests` data-access. Shared by the pulls module (list sync +
 * diff-stat backfill) and polling (manual sync) through `container.pullRequestRepo`,
 * so both sync paths write PRs with ONE rule. Workspace-scoped throughout.
 * Every method takes an optional `tx` so a service can compose it into a larger
 * `db.transaction`; the repository never opens one itself.
 */
export class PullRequestRepository implements PullRequestStore {
  constructor(private db: Db) {}

  private exec(tx?: PullsExecutor): Db {
    // A transaction exposes the same builders as the client; the cast avoids a
    // `Db | PgTransaction` union TypeScript can't resolve overloads across.
    return (tx ?? this.db) as Db;
  }

  /**
   * Persist a GitHub PR list in ONE multi-row `INSERT … ON CONFLICT (repo_id,
   * number) DO UPDATE`. On conflict only the fields GitHub changes on an open PR
   * are refreshed; diff stats are NOT overwritten (the list payload carries
   * zeros — real stats come from {@link updateDiffStats}), and `opened_at` /
   * `author` / `branch` / `base` keep their first-seen values.
   *
   * Returns the number of PRs written.
   */
  async upsertList(scope: PrScope, pulls: readonly PrMeta[], tx?: PullsExecutor): Promise<number> {
    if (pulls.length === 0) return 0;
    await this.exec(tx)
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
          title: excluded(t.pullRequests.title),
          headSha: excluded(t.pullRequests.headSha),
          status: excluded(t.pullRequests.status),
          updatedAt: excluded(t.pullRequests.updatedAt),
        },
      });
    return pulls.length;
  }

  /** Fill a PR's real diff stats (from the GitHub detail endpoint). No-op for another workspace's PR. */
  async updateDiffStats(
    workspaceId: string,
    prId: string,
    stats: DiffStats,
    tx?: PullsExecutor,
  ): Promise<void> {
    await this.exec(tx)
      .update(t.pullRequests)
      .set(stats)
      .where(and(eq(t.pullRequests.workspaceId, workspaceId), eq(t.pullRequests.id, prId)));
  }
}
