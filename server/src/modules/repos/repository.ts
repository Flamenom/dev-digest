import { and, asc, eq, sql } from 'drizzle-orm';
import type { RepoHost, RepoProvider } from '@devdigest/shared';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

/**
 * F1 — repos data-access layer. The ONLY place that touches the `repos`
 * table. Every query is scoped by `workspaceId` (tenancy guard).
 */

/** Physical row shape — private to this file; never crosses the repository boundary. */
type RepoRow = typeof t.repos.$inferSelect;

/**
 * A persisted repo as the rest of the module sees it. Mapped from the row at
 * this boundary (`toRecord`) so a column change is a repository-local edit, not
 * a change to the service/helpers/DTO signatures.
 */
export interface RepoRecord {
  id: string;
  workspaceId: string;
  owner: string;
  name: string;
  fullName: string;
  provider: RepoProvider;
  /** Stored host; normalised to a supported `RepoHost` by the DTO mapper. */
  host: string;
  defaultBranch: string;
  clonePath: string | null;
  lastPolledAt: Date | null;
  lastSyncedAt: Date | null;
  lastAttemptAt: Date | null;
  lastSyncError: string | null;
  createdBy: string | null;
  createdAt: Date;
}

function toRecord(row: RepoRow): RepoRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    owner: row.owner,
    name: row.name,
    fullName: row.fullName,
    provider: row.provider,
    host: row.host,
    defaultBranch: row.defaultBranch,
    clonePath: row.clonePath,
    lastPolledAt: row.lastPolledAt,
    lastSyncedAt: row.lastSyncedAt,
    lastAttemptAt: row.lastAttemptAt,
    lastSyncError: row.lastSyncError,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

export interface InsertRepo {
  workspaceId: string;
  owner: string;
  name: string;
  fullName: string;
  createdBy: string;
  /** Missing ⇒ github / github.com (column defaults). */
  provider?: RepoProvider;
  host?: RepoHost;
  /** Missing ⇒ column default (`main`). */
  defaultBranch?: string;
}

/** A repo's identity on its host — the dedupe key (AC-15/AC-16). */
export interface RepoIdentity {
  provider: RepoProvider;
  host: RepoHost;
  fullName: string;
}

export class RepoRepository {
  constructor(private db: Db) {}

  /**
   * Find a repo in a workspace by (provider, host, full name) — dedupe on add.
   * GitLab paths compare case-insensitively (gitlab.com paths are); GitHub keeps
   * its existing exact match.
   */
  async findByIdentity(workspaceId: string, id: RepoIdentity): Promise<RepoRecord | undefined> {
    const fullNameMatch =
      id.provider === 'gitlab'
        ? sql`lower(${t.repos.fullName}) = lower(${id.fullName})`
        : eq(t.repos.fullName, id.fullName);
    const [row] = await this.db
      .select()
      .from(t.repos)
      .where(
        and(
          eq(t.repos.workspaceId, workspaceId),
          eq(t.repos.provider, id.provider),
          eq(t.repos.host, id.host),
          fullNameMatch,
        ),
      )
      .orderBy(asc(t.repos.createdAt))
      .limit(1);
    return row ? toRecord(row) : undefined;
  }

  async list(workspaceId: string): Promise<RepoRecord[]> {
    const rows = await this.db
      .select()
      .from(t.repos)
      .where(eq(t.repos.workspaceId, workspaceId))
      .orderBy(asc(t.repos.createdAt), asc(t.repos.id));
    return rows.map(toRecord);
  }

  async getById(workspaceId: string, id: string): Promise<RepoRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(t.repos)
      .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.id, id)));
    return row ? toRecord(row) : undefined;
  }

  /**
   * Insert a repo. Returns `undefined` when the provider's identity unique index
   * already holds the row (a concurrent add won) — the caller re-reads it via
   * `findByIdentity` instead of surfacing a raw constraint error.
   *
   * The conflict target is scoped to exactly that identity index (migration 0020
   * made the two indexes disjoint by provider, so it is the ONLY unique index the
   * row can hit besides the random-uuid PK):
   *   - non-GitLab → `repos_ws_provider_host_fullname_uq` (exact full_name, partial
   *     `WHERE provider <> 'gitlab'`) — expressible with Drizzle's column target.
   *   - GitLab → `repos_gitlab_ws_host_lower_fullname_uq` on `lower(full_name)`.
   *     Drizzle 0.38's `onConflictDoNothing({ target })` only takes plain columns
   *     (it quotes each as an identifier), so the expression-index target is a raw
   *     `sql` INSERT; the row is then read back through the typed builder.
   */
  async insert(values: InsertRepo): Promise<RepoRecord | undefined> {
    if (values.provider === 'gitlab') return this.insertGitlab(values);
    const [row] = await this.db
      .insert(t.repos)
      .values({
        workspaceId: values.workspaceId,
        owner: values.owner,
        name: values.name,
        fullName: values.fullName,
        createdBy: values.createdBy,
        ...(values.provider ? { provider: values.provider } : {}),
        ...(values.host ? { host: values.host } : {}),
        ...(values.defaultBranch ? { defaultBranch: values.defaultBranch } : {}),
      })
      .onConflictDoNothing({
        target: [t.repos.workspaceId, t.repos.provider, t.repos.host, t.repos.fullName],
        where: t.reposIdentityWhere.nonGitlab(t.repos.provider),
      })
      .returning();
    return row ? toRecord(row) : undefined;
  }

  private async insertGitlab(values: InsertRepo): Promise<RepoRecord | undefined> {
    const host = values.host ?? sql`default`;
    const defaultBranch = values.defaultBranch ? values.defaultBranch : sql`default`;
    // Column names come from the schema objects (a rename breaks the build, not
    // the query); the arbiter predicate is the schema's own index predicate.
    const c = t.repos;
    const col = (column: { name: string }) => sql.identifier(column.name);
    const inserted = await this.db.execute<{ id: string }>(sql`
      insert into ${c}
        (${col(c.workspaceId)}, ${col(c.owner)}, ${col(c.name)}, ${col(c.fullName)},
         ${col(c.createdBy)}, ${col(c.provider)}, ${col(c.host)}, ${col(c.defaultBranch)})
      values
        (${values.workspaceId}, ${values.owner}, ${values.name}, ${values.fullName},
         ${values.createdBy}, 'gitlab', ${host}, ${defaultBranch})
      on conflict (${col(c.workspaceId)}, ${col(c.provider)}, ${col(c.host)}, lower(${col(c.fullName)}))
        where ${t.reposIdentityWhere.gitlab(c.provider)}
        do nothing
      returning ${col(c.id)}`);
    const id = inserted[0]?.id;
    return id ? this.getById(values.workspaceId, id) : undefined;
  }

  /**
   * Look up the workspace owning a repo (by repo id, no tenancy scope —
   * the JobRunner's `runCloneJob` is the only caller and it already trusted
   * the payload that came out of an authenticated `add()`). Returns null
   * if the repo was deleted before the followup ran.
   */
  async workspaceIdFor(repoId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ workspaceId: t.repos.workspaceId })
      .from(t.repos)
      .where(eq(t.repos.id, repoId));
    return row?.workspaceId ?? null;
  }

  /** Persist the clone path and bump `last_polled_at` once a clone job completes. */
  async updateClonePath(repoId: string, clonePath: string): Promise<void> {
    await this.db
      .update(t.repos)
      .set({ clonePath, lastPolledAt: new Date() })
      .where(eq(t.repos.id, repoId));
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(t.repos)
      .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.id, id)))
      .returning({ id: t.repos.id });
    return deleted.length > 0;
  }
}
