/** Pure helpers for SkillsTab — row ordering + full-set recomputation. */
import type { AgentSkillLink, Skill } from "@devdigest/shared";

/** Linked skill ids in link order (the canonical `skill_ids` payload). */
export function linkedIdsOf(links: AgentSkillLink[]): string[] {
  return [...links].sort((a, b) => a.order - b.order).map((l) => l.skill_id);
}

/** All workspace skills ordered for the tab: linked first (in link order), then unlinked. */
export function orderRows(skills: Skill[], linkedIds: string[]): Skill[] {
  const byId = new Map(skills.map((sk) => [sk.id, sk]));
  const linked = linkedIds.map((id) => byId.get(id)).filter((sk): sk is Skill => !!sk);
  const linkedSet = new Set(linkedIds);
  const unlinked = skills.filter((sk) => !linkedSet.has(sk.id));
  return [...linked, ...unlinked];
}

/** Full ordered set after a checkbox toggle: append on link, remove on unlink. */
export function toggleLinked(linkedIds: string[], skillId: string, on: boolean): string[] {
  if (on) return linkedIds.includes(skillId) ? linkedIds : [...linkedIds, skillId];
  return linkedIds.filter((id) => id !== skillId);
}

/** Move `id` to the position `overId` currently occupies (drag reorder). */
export function moveTo(ids: string[], id: string, overId: string): string[] {
  if (id === overId) return ids;
  const from = ids.indexOf(id);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** Case-insensitive name filter. */
export function matchesFilter(skill: Skill, filter: string): boolean {
  return skill.name.toLowerCase().includes(filter.trim().toLowerCase());
}
