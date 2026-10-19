import { and, asc, eq, inArray, notInArray, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { PrDetailHost, PrMeta, PrMetaHost, PrStatus, PullStateInfo } from '@devdigest/shared';
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

/** A persisted PR whose diff stats were never filled (all three are zero). */
export interface PrStatsGap {
  id: string;
  number: number;
}

/** Host-specific columns recorded alongside a full detail replace (GitLab). */
export interface DetailHostFields {
  isDraft: boolean | null;
  /** The head SHA the replaced files/commits were fetched at. */
  detailHeadSha: string;
}

/** One mirrored `pr_files` row, mapped to the domain (no Drizzle row type leaks out). */
export interface PersistedFile {
  path: string;
  additions: number;
  deletions: number;
  patch: string | null;
  previousPath: string | null;
  changeType: string | null;
  patchOmitted: string | null;
}

/** One mirrored `pr_commits` row, mapped to the domain. */
export interface PersistedCommit {
  sha: string;
  message: string;
  author: string;
  committedAt: Date | null;
}

/** A PR's mirrored files + commits as currently persisted. */
export interface PersistedDetail {
  files: PersistedFile[];
  commits: PersistedCommit[];
}

/**
 * Rows per multi-row INSERT in {@link PullRequestRepository.replaceDetail}.
 * Postgres caps one statement at 65 535 bind parameters; `pr_files` binds 8 per
 * row, so an unchunked insert breaks at ~8 192 files (no host caps MR size).
 * 500 rows × 8 = 4 000 params — far below the limit.
 */
export const DETAIL_INSERT_CHUNK = 500;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The `pull_requests` port — what consumers (and test fakes) depend on. */
export interface PullRequestStore {
  upsertList(scope: PrScope, pulls: readonly PrMeta[], tx?: PullsExecutor): Promise<number>;
  updateDiffStats(workspaceId: string, prId: string, stats: DiffStats, tx?: PullsExecutor): Promise<void>;
  upsertListWithStats(scope: PrScope, pulls: readonly PrMetaHost[], tx?: PullsExecutor): Promise<number>;
  listOpenNumbers(scope: PrScope, tx?: PullsExecutor): Promise<number[]>;
  updateStatuses(scope: PrScope, states: readonly PullStateInfo[], tx?: PullsExecutor): Promise<number>;
  listMissingStats(scope: PrScope, limit: number, tx?: PullsExecutor): Promise<PrStatsGap[]>;
  replaceDetail(
    workspaceId: string,
    prId: string,
    detail: PrDetailHost,
    hostFields: DetailHostFields | null,
    tx?: PullsExecutor,
  ): Promise<boolean>;
  /** The PR's mirrored files + commits (empty lists when none are persisted). */
  getPersistedDetail(prId: string, tx?: PullsExecutor): Promise<PersistedDetail>;
}

/** Host merge states that end a PR's life — everything else counts as open. */
const TERMINAL_STATUSES: readonly PrStatus[] = ['merged', 'closed'];

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
  /**
   * Persist a host PR list that may carry draft flags and (possibly unknown)
   * diff stats — the GitLab path (AC-18/50/54). Same ON CONFLICT target as
   * {@link upsertList}; on conflict it refreshes title / head / status /
   * updated_at / is_draft, and the stats ONLY when the new row's stats are
   * known — unknown stats never clobber previously known numbers. `stats_known`
   * becomes true once any upsert (or detail fetch) supplied real numbers.
   */
  async upsertListWithStats(
    scope: PrScope,
    pulls: readonly PrMetaHost[],
    tx?: PullsExecutor,
  ): Promise<number> {
    if (pulls.length === 0) return 0;
    const pr = t.pullRequests;
    const statsKnownNew = excluded(pr.statsKnown);
    /** `excluded.<col>` when the incoming stats are known, else the stored value. */
    const keepUnlessKnown = (column: AnyPgColumn): SQL =>
      sql`case when ${statsKnownNew} is true then ${excluded(column)} else ${column} end`;
    await this.exec(tx)
      .insert(pr)
      .values(
        pulls.map((p) => {
          const known = p.stats_known !== false;
          return {
            workspaceId: scope.workspaceId,
            repoId: scope.repoId,
            number: p.number,
            title: p.title,
            author: p.author,
            branch: p.branch,
            base: p.base,
            headSha: p.head_sha,
            additions: known ? p.additions : 0,
            deletions: known ? p.deletions : 0,
            filesCount: known ? p.files_count : 0,
            status: p.status,
            openedAt: p.opened_at ? new Date(p.opened_at) : null,
            updatedAt: p.updated_at ? new Date(p.updated_at) : null,
            isDraft: p.is_draft ?? null,
            statsKnown: known,
          };
        }),
      )
      .onConflictDoUpdate({
        target: [pr.repoId, pr.number],
        set: {
          title: excluded(pr.title),
          headSha: excluded(pr.headSha),
          status: excluded(pr.status),
          updatedAt: excluded(pr.updatedAt),
          isDraft: excluded(pr.isDraft),
          additions: keepUnlessKnown(pr.additions),
          deletions: keepUnlessKnown(pr.deletions),
          filesCount: keepUnlessKnown(pr.filesCount),
          statsKnown: sql`(${statsKnownNew} is true or ${pr.statsKnown} is true)`,
        },
        // Never cross tenants: a conflicting row must belong to the same workspace.
        setWhere: eq(pr.workspaceId, scope.workspaceId),
      });
    return pulls.length;
  }

  /** Numbers of the repo's persisted PRs still considered open (not merged/closed). */
  async listOpenNumbers(scope: PrScope, tx?: PullsExecutor): Promise<number[]> {
    const rows = await this.exec(tx)
      .select({ number: t.pullRequests.number })
      .from(t.pullRequests)
      .where(
        and(
          eq(t.pullRequests.workspaceId, scope.workspaceId),
          eq(t.pullRequests.repoId, scope.repoId),
          notInArray(t.pullRequests.status, [...TERMINAL_STATUSES]),
        ),
      );
    return rows.map((r) => r.number).sort((a, b) => a - b);
  }

  /**
   * Apply host-reported states (AC-28) — one UPDATE per distinct status.
   * Returns the number of rows updated. Unknown numbers are ignored.
   */
  async updateStatuses(
    scope: PrScope,
    states: readonly PullStateInfo[],
    tx?: PullsExecutor,
  ): Promise<number> {
    const byStatus = new Map<string, number[]>();
    for (const s of states) {
      const list = byStatus.get(s.status) ?? [];
      list.push(s.number);
      byStatus.set(s.status, list);
    }
    let updated = 0;
    for (const [status, numbers] of byStatus) {
      const rows = await this.exec(tx)
        .update(t.pullRequests)
        .set({ status })
        .where(
          and(
            eq(t.pullRequests.workspaceId, scope.workspaceId),
            eq(t.pullRequests.repoId, scope.repoId),
            inArray(t.pullRequests.number, numbers),
          ),
        )
        .returning({ id: t.pullRequests.id });
      updated += rows.length;
    }
    return updated;
  }

  /**
   * Up to `limit` PRs of the repo with all-zero diff stats (GitHub list payload
   * carries none) — the candidates for a detail backfill. Newest number first.
   */
  async listMissingStats(scope: PrScope, limit: number, tx?: PullsExecutor): Promise<PrStatsGap[]> {
    if (limit <= 0) return [];
    const pr = t.pullRequests;
    return this.exec(tx)
      .select({ id: pr.id, number: pr.number })
      .from(pr)
      .where(
        and(
          eq(pr.workspaceId, scope.workspaceId),
          eq(pr.repoId, scope.repoId),
          eq(pr.additions, 0),
          eq(pr.deletions, 0),
          eq(pr.filesCount, 0),
        ),
      )
      .orderBy(sql`${pr.number} desc`)
      .limit(limit);
  }

  /**
   * Replace a PR's mirrored files + commits and refresh its detail metadata
   * (body, diff stats). Delete-then-insert must be atomic — a failure between
   * the two would leave the PR with no diff — so it runs inside the caller's
   * `tx` when given, and otherwise in its own transaction (the one exception to
   * "never opens one itself", because a non-atomic replace is never correct).
   *
   * `hostFields` (GitLab) additionally records `is_draft`, `detail_head_sha`
   * and — only when `detail.stats_known !== false` — the diff stats plus
   * `stats_known = true`; unknown stats never clobber the persisted numbers.
   * `null` (GitHub) writes exactly today's columns.
   * Returns false (and writes nothing) when the PR is not in `workspaceId`.
   */
  async replaceDetail(
    workspaceId: string,
    prId: string,
    detail: PrDetailHost,
    hostFields: DetailHostFields | null,
    tx?: PullsExecutor,
  ): Promise<boolean> {
    if (!tx) return this.db.transaction((own) => this.replaceDetail(workspaceId, prId, detail, hostFields, own));
    const q = this.exec(tx);
    // GitHub (hostFields null) always carries real stats. GitLab may not
    // (patches omitted AND no diffStatsSummary) — then the persisted numbers and
    // stats_known are left untouched, same rule as upsertListWithStats (AC-54).
    const statsKnown = hostFields === null || detail.stats_known !== false;
    const owned = await q
      .update(t.pullRequests)
      .set({
        body: detail.body ?? null,
        ...(statsKnown
          ? { additions: detail.additions, deletions: detail.deletions, filesCount: detail.files_count }
          : {}),
        ...(hostFields
          ? {
              isDraft: hostFields.isDraft,
              detailHeadSha: hostFields.detailHeadSha,
              ...(statsKnown ? { statsKnown: true } : {}),
            }
          : {}),
      })
      .where(and(eq(t.pullRequests.workspaceId, workspaceId), eq(t.pullRequests.id, prId)))
      .returning({ id: t.pullRequests.id });
    if (owned.length === 0) return false;

    await q.delete(t.prFiles).where(eq(t.prFiles.prId, prId));
    // Chunked so a huge MR never exceeds the bind-parameter cap; every chunk
    // runs on the same `tx`, so the replace stays all-or-nothing.
    for (const batch of chunks(detail.files, DETAIL_INSERT_CHUNK)) {
      await q.insert(t.prFiles).values(
        batch.map((f) => ({
          prId,
          path: f.path,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch ?? null,
          previousPath: f.previous_path ?? null,
          changeType: f.change_type ?? null,
          patchOmitted: f.patch_omitted ?? null,
        })),
      );
    }
    await q.delete(t.prCommits).where(eq(t.prCommits.prId, prId));
    for (const batch of chunks(detail.commits, DETAIL_INSERT_CHUNK)) {
      await q.insert(t.prCommits).values(
        batch.map((c) => ({
          prId,
          sha: c.sha,
          message: c.message,
          author: c.author,
          committedAt: c.committed_at ? new Date(c.committed_at) : null,
        })),
      );
    }
    return true;
  }

  /**
   * The PR's mirrored files + commits, mapped row → domain at this boundary.
   * Deterministic order: files by `path`, commits chronologically (oldest first).
   * Tenancy is enforced by the caller having resolved `prId` within its
   * workspace (pr_files / pr_commits carry no workspace column of their own).
   */
  async getPersistedDetail(prId: string, tx?: PullsExecutor): Promise<PersistedDetail> {
    const q = this.exec(tx);
    const [files, commits] = await Promise.all([
      q
        .select({
          path: t.prFiles.path,
          additions: t.prFiles.additions,
          deletions: t.prFiles.deletions,
          patch: t.prFiles.patch,
          previousPath: t.prFiles.previousPath,
          changeType: t.prFiles.changeType,
          patchOmitted: t.prFiles.patchOmitted,
        })
        .from(t.prFiles)
        .where(eq(t.prFiles.prId, prId))
        .orderBy(asc(t.prFiles.path)),
      q
        .select({
          sha: t.prCommits.sha,
          message: t.prCommits.message,
          author: t.prCommits.author,
          committedAt: t.prCommits.committedAt,
        })
        .from(t.prCommits)
        .where(eq(t.prCommits.prId, prId))
        // Oldest-first, as both hosts return a PR's commits; undated commits
        // last, `sha` breaks timestamp ties (no insertion-order column exists).
        .orderBy(sql`${t.prCommits.committedAt} asc nulls last`, asc(t.prCommits.sha)),
    ]);
    return { files, commits };
  }
}

// ---- repos PR-list sync bookkeeping ----------------------------------------

/**
 * Persisted PR-list sync bookkeeping for one repo (the `repos` sync columns).
 * `running` is deliberately NOT here — it is in-memory only (the coordinator's
 * in-flight map), so a crash can never leave a repo stuck "running".
 */
export interface RepoSyncStatus {
  /** Last SUCCESSFUL sync. */
  lastSyncedAt: Date | null;
  /** Last attempt, successful or not. */
  lastAttemptAt: Date | null;
  /** Non-null ⇔ the last attempt failed (human-readable, secret-free). */
  lastSyncError: string | null;
}

/** The sync-status port the coordinator (and its test fakes) depend on. */
export interface SyncStatusStore {
  get(workspaceId: string, repoId: string, tx?: PullsExecutor): Promise<RepoSyncStatus | null>;
  recordSuccess(workspaceId: string, repoId: string, at: Date, tx?: PullsExecutor): Promise<void>;
  recordFailure(
    workspaceId: string,
    repoId: string,
    at: Date,
    error: string,
    tx?: PullsExecutor,
  ): Promise<void>;
}

/** Reads/writes `repos.last_synced_at / last_attempt_at / last_sync_error`. Workspace-scoped. */
export class SyncStatusRepository implements SyncStatusStore {
  constructor(private db: Db) {}

  private exec(tx?: PullsExecutor): Db {
    return (tx ?? this.db) as Db;
  }

  private scope(workspaceId: string, repoId: string) {
    return and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.id, repoId));
  }

  /** null when the repo does not exist in this workspace. */
  async get(workspaceId: string, repoId: string, tx?: PullsExecutor): Promise<RepoSyncStatus | null> {
    const [row] = await this.exec(tx)
      .select({
        lastSyncedAt: t.repos.lastSyncedAt,
        lastAttemptAt: t.repos.lastAttemptAt,
        lastSyncError: t.repos.lastSyncError,
      })
      .from(t.repos)
      .where(this.scope(workspaceId, repoId));
    return row ?? null;
  }

  async recordSuccess(workspaceId: string, repoId: string, at: Date, tx?: PullsExecutor): Promise<void> {
    await this.exec(tx)
      .update(t.repos)
      .set({ lastSyncedAt: at, lastAttemptAt: at, lastSyncError: null })
      .where(this.scope(workspaceId, repoId));
  }

  /** Keeps `last_synced_at` untouched — the list keeps showing the last good sync time (AC-25). */
  async recordFailure(
    workspaceId: string,
    repoId: string,
    at: Date,
    error: string,
    tx?: PullsExecutor,
  ): Promise<void> {
    await this.exec(tx)
      .update(t.repos)
      .set({ lastAttemptAt: at, lastSyncError: error })
      .where(this.scope(workspaceId, repoId));
  }
}
