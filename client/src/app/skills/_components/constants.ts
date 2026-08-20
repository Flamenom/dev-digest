/* Shared constants for the /skills route components (list, detail, import). */
import type { IconName } from "@devdigest/ui";
import type { SkillSource, SkillType } from "@devdigest/shared";

/** Selectable skill types (mirrors the frozen `SkillType` contract enum). */
export const SKILL_TYPES: readonly SkillType[] = ["rubric", "convention", "security", "custom"];

/** Type-badge text color per skill type (badge bg stays the default token). */
export const TYPE_COLORS: Record<SkillType, string> = {
  rubric: "var(--accent-text)",
  convention: "var(--ok)",
  security: "var(--crit)",
  custom: "var(--text-secondary)",
};

/** Source-badge icon per skill source (Manual ✎ / Extracted / Community ⊕ / Imported ↗). */
export const SOURCE_ICONS: Record<SkillSource, IconName> = {
  manual: "Edit",
  extracted: "Brain",
  community: "Users",
  imported_url: "ExternalLink",
};
