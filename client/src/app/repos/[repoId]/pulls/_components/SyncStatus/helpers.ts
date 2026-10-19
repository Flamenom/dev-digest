/** Pure helpers for the PR-list sync status line. */

export type SyncAge =
  | { unit: "now"; count: 0 }
  | { unit: "minutes" | "hours" | "days"; count: number };

/**
 * Bucket the age of the last successful sync for the "Synced …" label.
 * `null` when there was never a sync (or the timestamp is unparseable).
 */
export function syncAge(iso: string | null | undefined, now: number = Date.now()): SyncAge | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return { unit: "now", count: 0 };
  if (minutes < 60) return { unit: "minutes", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hours", count: hours };
  return { unit: "days", count: Math.floor(hours / 24) };
}

/** Absolute timestamp for the "showing data from …" notice; null when unknown. */
export function formatSyncTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
}
