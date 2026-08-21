/** Constants for the SmartDiffViewer (client-visual thresholds + group meta). */
import type { SmartDiffRole } from "@devdigest/shared";

/** Files with more changed lines than this get the large-file header highlight.
 *  Client-visual threshold — the SmartDiff contract carries no per-file flag. */
export const LARGE_FILE_LINES = 600;

/** Max lines painted per finding overlay — mirrors the server's
 *  FINDING_LINE_SPAN_CAP so badge counts and overlays derive from one rule. */
export const FINDING_LINE_SPAN_CAP = 10;

/** Worst-severity ranking for the per-line join (lower = worse = wins). */
export const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 0,
  WARNING: 1,
  SUGGESTION: 2,
};

/** Per-role section meta: i18n keys, square colour, default expansion.
 *  Boilerplate is ALWAYS collapsed by default (locked requirement). */
export const GROUP_META: Record<
  SmartDiffRole,
  { labelKey: string; subKey: string; color: string; defaultOpen: boolean }
> = {
  core: { labelKey: "coreLabel", subKey: "coreSub", color: "var(--accent)", defaultOpen: true },
  wiring: { labelKey: "wiringLabel", subKey: "wiringSub", color: "var(--warn)", defaultOpen: true },
  boilerplate: {
    labelKey: "boilerplateLabel",
    subKey: "boilerplateSub",
    color: "var(--info)",
    defaultOpen: false,
  },
};
