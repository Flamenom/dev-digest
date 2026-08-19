import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { ConventionCategory, ConventionStatus } from '@devdigest/shared';

/**
 * Conventions data-access. Owns `conventions` + `conventions_scans`.
 *
 * Invariant maintained on every status write: `accepted === (status ===
 * 'accepted')` — the boolean column exists for the frozen ConventionCandidate
 * contract and applied migration 0000; new code reads/writes `status`.
 *
 * The repo lookup queries `t.repos` directly (workspace-scoped) instead of
 * importing the repos module — the established cross-module-read precedent
 * (pulls, reviews).
 */

export type ConventionRow = typeof t.conventions.$inferSelect;
export type ScanRow = typeof t.conventionsScans.$inferSelect;

export interface NewConventionRow {
  category: ConventionCategory;
  rule: string;
  evidencePath: string;
  evidenceSnippet: string;
  evidenceStartLine: number | null;
  evidenceEndLine: number | null;
  confidence: number;
}

export class ConventionsRepository {
  constructor(private db: Db) {}

  async getRepo(
    workspaceId: string,
    repoId: string,
  ): Promise<{ id: string; owner: string; name: string; fullName: string } | undefined> {
    const [row] = await this.db
      .select({
        id: t.repos.id,
        owner: t.repos.owner,
        name: t.repos.name,
        fullName: t.repos.fullName,
      })
      .from(t.repos)
      .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.id, repoId)));
    return row;
  }

  async listByRepo(workspaceId: string, repoId: string): Promise<ConventionRow[]> {
    return this.db
      .select()
      .from(t.conventions)
      .where(and(eq(t.conventions.workspaceId, workspaceId), eq(t.conventions.repoId, repoId)))
      // Batch inserts share one createdAt, so confidence ties need a stable
      // tiebreaker — without it Postgres reorders ties on every refetch and
      // cards jump around after an accept/reject.
      .orderBy(desc(t.conventions.confidence), asc(t.conventions.createdAt), asc(t.conventions.id));
  }

  /** Re-scan semantics: wipe the repo's previous candidates, insert fresh — ONE transaction. */
  async replaceForRepo(
    workspaceId: string,
    repoId: string,
    rows: NewConventionRow[],
  ): Promise<ConventionRow[]> {
    return this.db.transaction(async (tx) => {
      await tx
        .delete(t.conventions)
        .where(and(eq(t.conventions.workspaceId, workspaceId), eq(t.conventions.repoId, repoId)));
      if (rows.length === 0) return [];
      return tx
        .insert(t.conventions)
        .values(rows.map((r) => ({ ...r, workspaceId, repoId, status: 'pending' as const })))
        .returning();
    });
  }

  async updateById(
    workspaceId: string,
    id: string,
    patch: { status?: ConventionStatus; rule?: string },
  ): Promise<ConventionRow | undefined> {
    const [row] = await this.db
      .update(t.conventions)
      .set({
        ...(patch.rule !== undefined ? { rule: patch.rule } : {}),
        ...(patch.status !== undefined
          ? { status: patch.status, accepted: patch.status === 'accepted' }
          : {}),
      })
      .where(and(eq(t.conventions.workspaceId, workspaceId), eq(t.conventions.id, id)))
      .returning();
    return row;
  }

  async bulkSetStatus(
    workspaceId: string,
    repoId: string,
    status: ConventionStatus,
  ): Promise<number> {
    const rows = await this.db
      .update(t.conventions)
      .set({ status, accepted: status === 'accepted' })
      .where(and(eq(t.conventions.workspaceId, workspaceId), eq(t.conventions.repoId, repoId)))
      .returning({ id: t.conventions.id });
    return rows.length;
  }

  async upsertScan(
    workspaceId: string,
    repoId: string,
    stats: { sampledFileCount: number; droppedCount: number },
  ): Promise<void> {
    await this.db
      .insert(t.conventionsScans)
      .values({ workspaceId, repoId, ...stats })
      .onConflictDoUpdate({
        target: t.conventionsScans.repoId,
        set: { ...stats, scannedAt: sql`now()` },
      });
  }

  async getScan(workspaceId: string, repoId: string): Promise<ScanRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.conventionsScans)
      .where(
        and(eq(t.conventionsScans.workspaceId, workspaceId), eq(t.conventionsScans.repoId, repoId)),
      );
    return row;
  }
}
