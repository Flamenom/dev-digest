/**
 * Settings repository — the workspace's non-secret prefs as key/value rows
 * (`settings` table). Secrets never live here; they go through SecretsProvider.
 *
 * Settings are WORKSPACE-WIDE (multi-user Q8): the table is unique on
 * `(workspace_id, key)` (migration 0024 collapsed legacy per-user duplicates),
 * so there is exactly one row per key and `user_id` only records who first
 * wrote it.
 */
import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { SettingsRow } from './helpers.js';

export class SettingsRepository {
  constructor(private db: Db) {}

  /** One row per key for the workspace, ordered by key (as GET /settings returns them). */
  async listRows(workspaceId: string): Promise<SettingsRow[]> {
    return this.db
      .select({ key: t.settings.key, value: t.settings.value })
      .from(t.settings)
      .where(eq(t.settings.workspaceId, workspaceId))
      .orderBy(asc(t.settings.key));
  }

  /**
   * Set each `key → value` workspace-wide; untouched keys keep their value.
   * One `INSERT … ON CONFLICT (workspace_id, key) DO UPDATE` for the whole
   * batch: an existing row is updated whoever created it (its author is kept);
   * a new key is inserted with `userId` as its author. Rows are sorted by key
   * so concurrent batches lock conflicting rows in the same order — opposite
   * caller orders can't deadlock.
   */
  async upsert(workspaceId: string, userId: string, entries: Record<string, unknown>): Promise<void> {
    const values = Object.entries(entries)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => ({ workspaceId, userId, key, value }));
    if (values.length === 0) return;
    await this.db
      .insert(t.settings)
      .values(values)
      .onConflictDoUpdate({
        target: [t.settings.workspaceId, t.settings.key],
        set: { value: sql`excluded.value` },
      });
  }
}
