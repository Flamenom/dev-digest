import type { SyncAge } from "./helpers";

/** Sync-age bucket → i18n key under `prReview.list.sync`. */
export const SYNCED_KEY: Record<SyncAge["unit"], string> = {
  now: "syncedNow",
  minutes: "syncedMinutes",
  hours: "syncedHours",
  days: "syncedDays",
};
