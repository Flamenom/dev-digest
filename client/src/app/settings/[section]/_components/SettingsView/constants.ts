/** Default settings section when none is provided in the route. */
export const DEFAULT_SECTION = "api-keys";

/** Section keys that have a bespoke implemented panel. */
export const SECTION_API_KEYS = "api-keys";
export const SECTION_MODELS = "models";
export const SECTION_MEMBERS = "members";
export const SECTION_API_TOKENS = "api-tokens";

/** Multi-user sections appended locally after the design-system
 *  `SETTINGS_SECTIONS` (vendor/ui/nav.ts stays untouched — plan Rec-4).
 *  `googleOnly` sections are hidden in local mode (UI gating table). */
export interface ExtraSectionSpec {
  key: string;
  /** i18n key under the `settings` namespace. */
  labelKey: string;
  googleOnly: boolean;
}

export const EXTRA_SECTIONS: readonly ExtraSectionSpec[] = [
  { key: SECTION_MEMBERS, labelKey: "members.navLabel", googleOnly: true },
  { key: SECTION_API_TOKENS, labelKey: "apiTokens.navLabel", googleOnly: true },
];
