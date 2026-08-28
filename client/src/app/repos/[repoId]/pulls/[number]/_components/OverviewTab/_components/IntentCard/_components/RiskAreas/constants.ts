import { SEV } from "@devdigest/ui";
import type { IconName } from "@devdigest/ui";
import type { RiskSeverity } from "@devdigest/shared";

/** Icon size for the leading severity/kind glyph on a risk row. */
export const RISK_ICON_SIZE = 13;

/** Icon size for the expand/collapse chevron. */
export const RISK_CHEVRON_SIZE = 14;

/**
 * Brief risk severity → the design-system severity tone (colours live in
 * `vendor/ui/primitives/tokens.ts`, so risk rows stay in the same palette as
 * finding severities). `.label` is deliberately unused — the accessible label
 * comes from `brief.card.riskLevel.*` so it reads as a risk band, not a
 * finding severity.
 */
export const SEVERITY_TONE: Record<RiskSeverity, (typeof SEV)[keyof typeof SEV]> = {
  high: SEV.CRITICAL,
  medium: SEV.WARNING,
  low: SEV.SUGGESTION,
};

/**
 * Optional per-kind glyph. `BriefRisk.kind` is free-form model output, so this
 * is an allow-list of recognised kinds only — anything else falls back to the
 * severity glyph (see `helpers.riskIcon`).
 */
export const KIND_ICON: Record<string, IconName> = {
  security: "Shield",
  auth: "Shield",
  authz: "Shield",
  secret: "Lock",
  dependency: "Boxes",
  dependencies: "Boxes",
  deps: "Boxes",
  performance: "Zap",
  perf: "Zap",
  data: "Database",
  migration: "Database",
  api: "Globe",
  contract: "Globe",
  test: "FlaskConical",
  testing: "FlaskConical",
  config: "Wrench",
  operability: "Activity",
};
