/** Pure helpers for the skill ContextTab — row ordering, filtering, and
    full-ordered-set recomputation (the PUT payload is always the whole list). */
import type { DiscoveredDocument } from "@devdigest/shared";

/** Last path segment — the display filename of a discovered document. */
export function fileName(path: string): string {
  const seg = path.split("/").filter(Boolean);
  return seg[seg.length - 1] ?? path;
}

/** Rows ordered for the tab: attached first (in attached order), then the rest
    in discovery order. */
export function orderDocs(
  documents: DiscoveredDocument[],
  attached: string[],
): DiscoveredDocument[] {
  const byPath = new Map(documents.map((d) => [d.path, d]));
  const head = attached
    .map((p) => byPath.get(p))
    .filter((d): d is DiscoveredDocument => !!d);
  const attachedSet = new Set(attached);
  const tail = documents.filter((d) => !attachedSet.has(d.path));
  return [...head, ...tail];
}

/** Case-insensitive filename/path filter (AC-15/AC-12 — never touches attach state). */
export function matchesQuery(doc: DiscoveredDocument, query: string): boolean {
  const q = query.trim().toLowerCase();
  return doc.path.toLowerCase().includes(q) || fileName(doc.path).toLowerCase().includes(q);
}

/** Full ordered path set after a toggle: append on attach, remove on detach. */
export function togglePath(attached: string[], path: string, on: boolean): string[] {
  if (on) return attached.includes(path) ? attached : [...attached, path];
  return attached.filter((p) => p !== path);
}

/** Move `path` by `delta` positions; returns the SAME array when out of range. */
export function movePath(attached: string[], path: string, delta: number): string[] {
  const from = attached.indexOf(path);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= attached.length) return attached;
  const next = [...attached];
  next.splice(from, 1);
  next.splice(to, 0, path);
  return next;
}

/** Move `path` to the position `overPath` currently occupies (drag reorder). */
export function moveTo(attached: string[], path: string, overPath: string): string[] {
  if (path === overPath) return attached;
  const from = attached.indexOf(path);
  const to = attached.indexOf(overPath);
  if (from < 0 || to < 0) return attached;
  const next = [...attached];
  next.splice(from, 1);
  next.splice(to, 0, path);
  return next;
}

/** The literal prompt contribution: the `## Project context` heading plus the
    contributed paths (AC-17). This is serialized prompt content, not UI copy. */
export function serializePreview(attached: string[]): string {
  return ["## Project context", ...attached.map((p) => `- ${p}`)].join("\n");
}
