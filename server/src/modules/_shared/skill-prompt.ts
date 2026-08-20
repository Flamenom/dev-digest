/**
 * L02 — run-side skill split, shared between the skills module and the review
 * run-executor (which must not import a sibling module folder; `_shared` is
 * the one shared slice). Pure; structurally typed so it depends on no module.
 *
 * Linked skills (already ordered by agent_skills.order) → the prompt-ready
 * blocks for the globally-ENABLED ones + the count of disabled ones skipped.
 * Each injected block is `### <name>\n<body>`; the engine assembles them into
 * the `## Skills / rules` section.
 */
export function splitEnabledSkills(
  rows: { name: string; body: string; enabled: boolean }[],
): { injected: string[]; skipped: number } {
  const enabled = rows.filter((r) => r.enabled);
  return {
    injected: enabled.map((r) => `### ${r.name}\n${r.body}`),
    skipped: rows.length - enabled.length,
  };
}
