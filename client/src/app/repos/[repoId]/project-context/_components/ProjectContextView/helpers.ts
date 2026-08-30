/** Pure helpers for the Project Context view. */

/** `docs/adr/0001-onion.md` → `{ name: "0001-onion.md", folder: "docs/adr" }`. */
export function splitPath(path: string): { name: string; folder: string } {
  const i = path.lastIndexOf("/");
  if (i < 0) return { name: path, folder: "" };
  return { name: path.slice(i + 1), folder: path.slice(0, i) };
}

export type RelativeTime =
  | { key: "justNow" }
  | { key: "minutesAgo" | "hoursAgo" | "daysAgo"; count: number };

/** ISO timestamp → i18n key + count, translated by the caller (`time.*`). */
export function relativeTime(iso: string, now: Date = new Date()): RelativeTime {
  const then = new Date(iso).getTime();
  const sec = Number.isNaN(then) ? 0 : Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (sec < 60) return { key: "justNow" };
  const min = Math.floor(sec / 60);
  if (min < 60) return { key: "minutesAgo", count: min };
  const hours = Math.floor(min / 60);
  if (hours < 24) return { key: "hoursAgo", count: hours };
  return { key: "daysAgo", count: Math.floor(hours / 24) };
}
