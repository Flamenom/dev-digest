import { SEV } from "@devdigest/ui";
import type { IconName } from "@devdigest/ui";
import type { RiskSeverity } from "@devdigest/shared";

/** Score gauge geometry — slightly larger than the per-run VerdictBanner gauge. */
export const GAUGE_SIZE = 56;
export const GAUGE_STROKE = 5;

/** Status icon inside the tinted square, mirroring VerdictBanner. */
export const STATUS_ICON_SIZE = 22;

/** Height of the loading skeleton shown while the brief query resolves. */
export const SKELETON_HEIGHT = 132;

/**
 * Colour per `risk_level` band. These are `CircularScore`'s OWN band colours
 * (`vendor/ui/primitives/CircularScore.tsx:14`: `>= 75 → --ok`, `>= 50 → --warn`,
 * else `--crit`), so the text label can never contradict the gauge (AC-16a,
 * AC-40). The bands themselves are NOT re-derived here — `risk_level` arrives
 * from the server (`riskLevelFromScore`).
 */
export const RISK_LEVEL_COLOR: Record<RiskSeverity, string> = {
  high: SEV.CRITICAL.c, // var(--crit)
  medium: SEV.WARNING.c, // var(--warn)
  low: "var(--ok)",
};

/** `not_reviewed` has no `Verdict` entry — same shape as `VERDICT_META` (AC-18). */
export const NOT_REVIEWED_META: { c: string; bg: string; icon: IconName } = {
  c: "var(--text-muted)",
  bg: "var(--bg-hover)",
  icon: "Clock",
};
