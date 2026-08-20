import { z } from 'zod';
import { SkillUsageAgent } from './skills-usage.js';

/**
 * L02 follow-up — per-skill stats DTO.
 *
 * `SkillStats` backs GET /skills/:id/stats — the Stats tab's data in one
 * request: how many agents link the skill (and which), how many body
 * snapshots exist, and when the body last changed. Restore
 * (POST /skills/:id/restore) returns the plain `Skill` DTO, so it needs no
 * contract of its own beyond the `{ version }` request body.
 */
export const SkillStats = z.object({
  skill_id: z.string(),
  used_by_agents: z.number().int(),
  agents: z.array(SkillUsageAgent),
  version_count: z.number().int(),
  latest_version: z.number().int(),
  /** ISO date of the newest body snapshot; null when none exist. */
  last_updated_at: z.string().nullable(),
});
export type SkillStats = z.infer<typeof SkillStats>;
