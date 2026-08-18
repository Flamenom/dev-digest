/* Pure helpers for the SkillsList column. */
import type { Skill, SkillUsage } from "@devdigest/shared";

/** Client-side search filter over skill name + type. */
export function filterSkills(skills: Skill[], search: string): Skill[] {
  const q = search.trim().toLowerCase();
  if (!q) return skills;
  return skills.filter(
    (sk) => sk.name.toLowerCase().includes(q) || sk.type.toLowerCase().includes(q),
  );
}

/** skill_id → number of linked agents, from GET /skills/usage. */
export function usageCounts(usage: SkillUsage[] | undefined): Map<string, number> {
  return new Map((usage ?? []).map((u) => [u.skill_id, u.agents.length]));
}
