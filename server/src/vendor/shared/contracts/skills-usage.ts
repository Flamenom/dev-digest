import { z } from 'zod';

/**
 * L02 — skill usage + version history DTOs.
 *
 * `SkillUsage` backs GET /skills/usage — which agents link each skill
 * (list-card "N agents" stat and the Stats tab). `SkillVersionEntry` backs
 * GET /skills/:id/versions — bodies are included so the client can diff
 * versions locally.
 */
export const SkillUsageAgent = z.object({
  id: z.string(),
  name: z.string(),
});
export type SkillUsageAgent = z.infer<typeof SkillUsageAgent>;

export const SkillUsage = z.object({
  skill_id: z.string(),
  agents: z.array(SkillUsageAgent),
});
export type SkillUsage = z.infer<typeof SkillUsage>;

export const SkillVersionEntry = z.object({
  skill_id: z.string(),
  version: z.number().int(),
  /** Optional "what changed" note captured on body saves. */
  note: z.string().nullable(),
  body: z.string(),
  created_at: z.string(),
});
export type SkillVersionEntry = z.infer<typeof SkillVersionEntry>;
