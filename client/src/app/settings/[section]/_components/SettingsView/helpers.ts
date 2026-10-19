import type { AuthMode } from "@devdigest/shared";
import { SETTINGS_SECTIONS } from "@devdigest/ui";
import { EXTRA_SECTIONS } from "./constants";

/** A settings sub-nav entry. */
export interface SettingsSection {
  key: string;
  label: string;
}

/**
 * The settings sub-nav for the current auth mode: the design-system sections
 * first, then the multi-user ones. Google-only sections are left out while the
 * mode is unknown (session probe in flight) or `local`.
 */
export function visibleSections(
  mode: AuthMode | null,
  translate: (key: string) => string,
): [SettingsSection, ...SettingsSection[]] {
  const extra = EXTRA_SECTIONS.filter((sec) => !sec.googleOnly || mode === "google").map(
    (sec) => ({ key: sec.key, label: translate(sec.labelKey) }),
  );
  const [first, ...rest] = SETTINGS_SECTIONS;
  return [{ key: first.key, label: first.label }, ...rest.map((sec) => ({ key: sec.key, label: sec.label })), ...extra];
}

/** Medium date ("Oct 19, 2026") for an ISO timestamp; `fallback` when null/invalid. */
export function formatDate(iso: string | null | undefined, fallback: string): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(d);
}
