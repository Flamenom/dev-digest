import type { IconName } from "@devdigest/ui";
import type { BriefRisk, BriefRiskRef } from "@devdigest/shared";
import { KIND_ICON, SEVERITY_TONE } from "./constants";

/** `path:12` for a single line, `path:12-18` for a range. */
export function refLabel(ref: BriefRiskRef): string {
  return ref.end_line != null && ref.end_line !== ref.start_line
    ? `${ref.path}:${ref.start_line}-${ref.end_line}`
    : `${ref.path}:${ref.start_line}`;
}

/**
 * Glyph for a risk row: the recognised kind's icon, else the severity icon.
 * `kind` is untrusted model output, so the lookup is `Object.hasOwn`-guarded —
 * a plain `KIND_ICON[kind]` would resolve inherited keys (`constructor`,
 * `toString`) to non-icon values.
 */
export function riskIcon(risk: BriefRisk): IconName {
  const kind = risk.kind.trim().toLowerCase();
  const known = Object.hasOwn(KIND_ICON, kind) ? KIND_ICON[kind] : undefined;
  return known ?? SEVERITY_TONE[risk.severity].icon;
}
