/** Pure helpers for ContextTab — row ordering + full-set recomputation, keyed by path. */
import type { DiscoveredDocument } from "@devdigest/shared";

/** Filename component of a repo-relative path. */
export function fileNameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/** Folder component of a repo-relative path ("" for root-level files). */
export function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** All discovered docs ordered for the tab: attached first (in attach order), then the rest. */
export function orderRows(
  docs: DiscoveredDocument[],
  attachedPaths: string[],
): DiscoveredDocument[] {
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const attached = attachedPaths
    .map((p) => byPath.get(p))
    .filter((d): d is DiscoveredDocument => !!d);
  const attachedSet = new Set(attachedPaths);
  const rest = docs.filter((d) => !attachedSet.has(d.path));
  return [...attached, ...rest];
}

/** Full ordered set after a toggle: append on attach, remove on detach. */
export function togglePath(paths: string[], path: string, on: boolean): string[] {
  if (on) return paths.includes(path) ? paths : [...paths, path];
  return paths.filter((p) => p !== path);
}

/** Move `path` to the position `overPath` currently occupies (drag reorder). */
export function moveTo(paths: string[], path: string, overPath: string): string[] {
  if (path === overPath) return paths;
  const from = paths.indexOf(path);
  const to = paths.indexOf(overPath);
  if (from < 0 || to < 0) return paths;
  const next = [...paths];
  next.splice(from, 1);
  next.splice(to, 0, path);
  return next;
}

/** Move `path` one step up (-1) or down (+1) — keyboard alternative to drag. */
export function moveBy(paths: string[], path: string, delta: -1 | 1): string[] {
  const from = paths.indexOf(path);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= paths.length) return paths;
  const next = [...paths];
  next.splice(from, 1);
  next.splice(to, 0, path);
  return next;
}

/** Case-insensitive filter on filename OR full path — never mutates attach state. */
export function matchesFilter(doc: DiscoveredDocument, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  return fileNameOf(doc.path).toLowerCase().includes(q) || doc.path.toLowerCase().includes(q);
}

/** Sum of estimated tokens over the attached set (paths absent from discovery count 0). */
export function attachedTokensOf(docs: DiscoveredDocument[], attachedPaths: string[]): number {
  const byPath = new Map(docs.map((d) => [d.path, d.estimated_tokens]));
  return attachedPaths.reduce((sum, p) => sum + (byPath.get(p) ?? 0), 0);
}
