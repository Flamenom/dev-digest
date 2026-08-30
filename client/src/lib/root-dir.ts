/** Root-directory of a repo-relative path — the FIRST path segment.
    `docs/adr/one.md` → "docs", `server/docs/api.md` → "server".
    Returns null for root-level files (no slash); callers fall back to the
    document's bucket. Pure — shared by the Project Context page and the
    agent/skill Context tabs. */
export function rootDirOf(path: string): string | null {
  const i = path.indexOf("/");
  return i > 0 ? path.slice(0, i) : null;
}
