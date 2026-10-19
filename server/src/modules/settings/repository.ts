/**
 * Settings repository — the workspace's non-secret prefs as key/value rows
 * (`settings` table). Secrets never live here; they go through SecretsProvider.
 *
 * Settings are WORKSPACE-WIDE (multi-user Q8). The table's unique index is
 * `(workspace_id, user_id, key)`, so a plain per-user upsert would give a
 * second Admin a shadow row. Writes therefore update by `(workspace, key)`
 * and insert (attributed to the acting user) only when no row exists; reads
 * collapse any legacy duplicates to one value per key.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { SettingsRow } from './helpers.js';

export class SettingsRepository {
  constructor(private db: Db) {}

  /** One row per key for the workspace (workspace-wide prefs, as GET /settings returns them). */
  async listRows(workspaceId: string): Promise<SettingsRow[]> {
    const rows = await this.db
      .select({ key: t.settings.key, value: t.settings.value })
      .from(t.settings)
      .where(eq(t.settings.workspaceId, workspaceId));
    // Legacy per-user duplicates carry the same value after any workspace-wide
    // write; dedupe so the result is one entry per key regardless.
    const byKey = new Map<string, SettingsRow>();
    for (const r of rows) if (!byKey.has(r.key)) byKey.set(r.key, r);
    return [...byKey.values()];
  }

  /**
   * Set each `key → value` workspace-wide; untouched keys keep their value.
   * An existing `(workspace, key)` row is updated whoever created it; a new key
   * is inserted with `userId` as its author. One transaction for the batch,
   * with a per-(workspace, key) advisory lock so two concurrent first saves of
   * the same key can't both insert.
   */
  async upsert(workspaceId: string, userId: string, entries: Record<string, unknown>): Promise<void> {
    // Sorted by key so concurrent batches take the per-key advisory locks in
    // the same global order — opposite caller orders can't deadlock.
    const pairs = Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (pairs.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const [key, value] of pairs) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`settings:${workspaceId}:${key}`}, 0))`,
        );
        const updated = await tx
          .update(t.settings)
          .set({ value })
          .where(and(eq(t.settings.workspaceId, workspaceId), eq(t.settings.key, key)))
          .returning({ id: t.settings.id });
        if (updated.length === 0) {
          await tx.insert(t.settings).values({ workspaceId, userId, key, value });
        }
      }
    });
  }
}
