import type { IconName } from "@devdigest/ui";

/** Detail tab descriptor. `labelKey` resolves under the `skills` namespace. */
export interface DetailTab {
  key: string;
  labelKey: string;
  icon: IconName;
}

/** Detail tabs — Config | Preview | Stats | Versions. NO Evals tab and no
    "Run on evals" button in this scope (spec decision 7). */
export const TABS: readonly DetailTab[] = [
  { key: "config", labelKey: "tabs.config", icon: "Settings" },
  { key: "preview", labelKey: "tabs.preview", icon: "Eye" },
  { key: "stats", labelKey: "tabs.stats", icon: "BarChart" },
  { key: "versions", labelKey: "tabs.versions", icon: "History" },
];

export const TAB_KEYS: readonly string[] = TABS.map((t) => t.key);

export const DEFAULT_TAB = "config";
