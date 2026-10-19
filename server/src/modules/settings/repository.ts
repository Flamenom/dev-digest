/**
 * Settings repository — the workspace's non-secret prefs as key/value rows
 * (`settings` table). Secrets never live here; they go through SecretsProvider.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { SettingsRow } from './helpers.js';

export class SettingsRepository {
  constructor(private db: Db) {}

  /** Every pref row of the workspace (all users' rows, as GET /settings returns them). */
  async listRows(workspaceId: string): Promise<SettingsRow[]> {
    return this.db
      .select({ key: t.settings.key, value: t.settings.value })
      .from(t.settings)
      .where(eq(t.settings.workspaceId, workspaceId));
  }

  /** Upsert each `key → value` for (workspace, user); untouched keys keep their value. */
  async upsert(workspaceId: string, userId: string, entries: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      await this.db
        .insert(t.settings)
        .values({ workspaceId, userId, key, value })
        .onConflictDoUpdate({
          target: [t.settings.workspaceId, t.settings.userId, t.settings.key],
          set: { value },
        });
    }
  }
}
