/**
 * Spec-path union resolver for review-run document injection (AC-19, AC-21).
 *
 * Pure application-ring helper — no I/O, no imports. The executor decides
 * WHICH skills are loaded (only enabled skills contribute, AC-18); this
 * function trusts its input and only fixes the ordering + dedupe policy:
 * agent-attached paths in persisted order first, then each loaded skill's
 * paths in skill-load order then persisted order, deduplicated by exact
 * repo-relative path string keeping the FIRST occurrence.
 */

export interface ResolveSpecPathsInput {
  agentPaths: string[];
  loadedSkills: { paths: string[] }[];
}

export function resolveSpecPaths(input: ResolveSpecPathsInput): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  const add = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    ordered.push(path);
  };

  for (const path of input.agentPaths) add(path);
  for (const skill of input.loadedSkills) {
    for (const path of skill.paths) add(path);
  }

  return ordered;
}
