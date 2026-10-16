/* helpers.ts — pure display formatters for the eval compare modal (spec §9.1).
   No React and no I/O, so the modal and its test can exercise them directly. */

import type { EvalPromptDiffLine } from "@devdigest/shared";

/** Rendered wherever a metric or a delta is absent — never "0" (§9.1). */
export const EM_DASH = "—";

/** Direction of a metric change. Drives the glyph AND the colour, so colour is
    never the only carrier of the meaning (AC-44, §14). */
export type DeltaTone = "up" | "down" | "flat" | "none";

/** Text glyph per direction. `none` (a null delta) renders the em dash alone. */
const GLYPH: Record<DeltaTone, string> = {
  up: "▲",
  down: "▼",
  flat: "=",
  none: "",
};

/** Leading character that encodes a prompt-diff line's kind as TEXT, so the
    red/green background is never the only signal (§14, AC-44). U+2212 matches
    the `compare.legendOld` message. */
export const DIFF_PREFIX: Record<EvalPromptDiffLine["kind"], string> = {
  added: "+",
  removed: "−",
  context: " ",
};

/** `0.78` → `"78%"`; a null metric renders the em dash, never a vacuous 0%. */
export function formatPercent(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return EM_DASH;
  return `${Math.round(v * 100)}%`;
}

/** `0.0123` → `"$0.0123"`. Batch cost is summed in USD and is often sub-cent. */
export function formatCost(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return EM_DASH;
  return `$${v.toFixed(4)}`;
}

/**
 * Fraction → points, rounded **half away from zero**.
 *
 * JS `Math.round(-2.5)` is `-2` while `Math.round(2.5)` is `3`, so the naive
 * version reports a −2.5 pt drop as −2 and a +2.5 pt rise as +3. The server's
 * alert rule (§8.4) applies the same correction; the modal must not disagree
 * with the banner that sent the user here.
 */
export function roundPts(delta: number): number {
  return Math.sign(delta) * Math.round(Math.abs(delta) * 100);
}

export interface DeltaDisplay {
  /** Glyph + magnitude + unit, e.g. `"▲4pt"`. Never colour-only (AC-44). */
  text: string;
  tone: DeltaTone;
}

/** A recall / precision / citation delta as `▲4pt`, `▼4pt`, `=0pt` or `—`. */
export function percentDelta(delta: number | null | undefined): DeltaDisplay {
  if (delta == null || !Number.isFinite(delta)) return { text: EM_DASH, tone: "none" };
  const pts = roundPts(delta);
  const tone: DeltaTone = pts > 0 ? "up" : pts < 0 ? "down" : "flat";
  return { text: `${GLYPH[tone]}${Math.abs(pts)}pt`, tone };
}

/** A cost delta as `▲$0.0031`. Cost is money, not points, so it carries `$`. */
export function costDelta(delta: number | null | undefined): DeltaDisplay {
  if (delta == null || !Number.isFinite(delta)) return { text: EM_DASH, tone: "none" };
  // Compare on the rendered precision so "▲$0.0000" can never appear.
  const rounded = Number(delta.toFixed(4));
  const tone: DeltaTone = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
  return { text: `${GLYPH[tone]}$${Math.abs(rounded).toFixed(4)}`, tone };
}

/** A batch's `agent_version`; `null` on rows written before migration 0018. */
export function versionLabel(v: number | null | undefined): string {
  return v == null ? EM_DASH : String(v);
}

/**
 * Deterministic UTC stamp. The modal is client-only (Modal portals after
 * mount), but a locale-dependent string would still make the rendered subtitle
 * depend on the machine running the test.
 */
export function formatRanAt(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Read an `ApiError.code` off an unknown rejection **by shape**. The compare
 * route answers 422 `same_batch` / `cross_agent_compare` (§9.1) and 4xx stays
 * silent globally (client/CLAUDE.md), so the modal renders it inline.
 */
export function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
