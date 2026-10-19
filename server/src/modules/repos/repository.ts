import { and, asc, eq, sql } from 'drizzle-orm';
import type { RepoHost, RepoProvider } from '@devdigest/shared';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

/**
 * F1 — repos data-access layer. The ONLY place that touches the `repos`
 * table. Every query is scoped by `workspaceId` (tenancy guard).
 */

export type RepoRow = typeof t.repos.$inferSelect;

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
  async findByIdentity(workspaceId: string, id: RepoIdentity): Promise<RepoRow | undefined> {
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
    return row;
  }

  async list(workspaceId: string): Promise<RepoRow[]> {
    return this.db
      .select()
      .from(t.repos)
      .where(eq(t.repos.workspaceId, workspaceId))
      .orderBy(asc(t.repos.createdAt), asc(t.repos.id));
  }

  async getById(workspaceId: string, id: string): Promise<RepoRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.repos)
      .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.id, id)));
    return row;
  }

  /**
   * Insert a repo. Returns `undefined` when the (workspace, provider, host,
   * full_name) unique index already holds the row (a concurrent add won) —
   * the caller re-reads it instead of surfacing a raw constraint error.
   */
  async insert(values: InsertRepo): Promise<RepoRow | undefined> {
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
      .onConflictDoNothing()
      .returning();
    return row;
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
