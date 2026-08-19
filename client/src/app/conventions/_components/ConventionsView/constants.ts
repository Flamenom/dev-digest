/* Literal re-declarations of the shared enums: the client may only import
   TYPES from @devdigest/shared (a runtime value pulls the contracts barrel
   into the webpack bundle — see lib/feature-models.ts). */
import type { ConventionCategory } from "@devdigest/shared";

export const CONVENTION_CATEGORIES: readonly ConventionCategory[] = [
  "naming",
  "structure",
  "imports",
  "error-handling",
  "typing",
  "testing",
  "styling",
  "api-design",
  "other",
];

/** category → Badge tint (fg color; bg stays the default hover surface). */
export const CATEGORY_COLORS: Record<ConventionCategory, string> = {
  naming: "var(--sugg)",
  structure: "var(--accent)",
  imports: "var(--info)",
  "error-handling": "var(--warn)",
  typing: "var(--accent)",
  testing: "var(--ok)",
  styling: "var(--sugg)",
  "api-design": "var(--info)",
  other: "var(--text-secondary)",
};
