import { z } from 'zod';
import { SkillType } from './knowledge.js';

/**
 * L02 — skill import (POST /skills/import).
 *
 * The endpoint is parse-only: it extracts the skill core from an uploaded
 * `.md` file or a Claude-style `.zip` (SKILL.md inside) and returns this
 * preview WITHOUT persisting anything. Saving happens via the normal
 * POST /skills after the user confirms. Archive entries other than SKILL.md
 * are never read — only their names are reported in `skipped`.
 */
export const SkillImportPreview = z.object({
  name: z.string(),
  description: z.string(),
  /** Markdown body with the frontmatter stripped. */
  body: z.string(),
  /** Heuristic type suggestion; the user can change it before saving. */
  suggested_type: SkillType,
  /** Archive entries that were refused (never extracted or executed). */
  skipped: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type SkillImportPreview = z.infer<typeof SkillImportPreview>;
