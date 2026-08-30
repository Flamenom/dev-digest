import { z } from 'zod';
import { RiskSeverity } from './brief.js';
import { Verdict } from './findings.js';

/**
 * PR "Why / Risk" Brief (spec `specs/2026-08-27-pr-brief.md`).
 *
 * ADDITIVE contract — no pre-existing contract file is edited. The frozen
 * `PrBrief` in `contracts/brief.ts` composes `{ intent, blast, risks, history }`,
 * which is NOT the shape this feature needs, so everything here uses distinct
 * names. `RiskSeverity` (`contracts/brief.ts`) and `Verdict`
 * (`contracts/findings.ts`) are REUSED as-is, never redefined.
 *
 * Two shapes live here and must not be confused:
 *  - `PrBriefGeneration` — exactly what the single structured model call returns.
 *  - `PrBriefDetail`     — the card payload the API serves (model content +
 *                          deterministic rollup + provenance + staleness).
 *
 * [D1] The model emits NEITHER a score NOR a `risk_level`: the score is the
 * deterministic review rollup (AC-16) and `risk_level` is derived from it
 * server-side via `riskLevelFromScore` (AC-16a).
 */

// ---- Model output building blocks ----

/** A grounded file reference for a risk. `end_line` is optional (single-line refs). */
export const BriefRiskRef = z.object({
  path: z.string(),
  start_line: z.number().int(),
  end_line: z.number().int().nullish(),
});
export type BriefRiskRef = z.infer<typeof BriefRiskRef>;

/**
 * One risk area. The `.max()` caps ARE the AC-14 output caps: an over-long
 * answer fails parsing and is repaired/retried instead of being persisted.
 */
export const BriefRisk = z.object({
  kind: z.string(),
  title: z.string().max(80),
  explanation: z.string().max(300),
  severity: RiskSeverity,
  refs: z.array(BriefRiskRef),
});
export type BriefRisk = z.infer<typeof BriefRisk>;

/**
 * One "review this first" pointer, ordered most-important-first.
 * [D3] `finding_id` is present only when the entry corresponds to an input finding.
 */
export const ReviewFocusEntry = z.object({
  path: z.string(),
  line: z.number().int(),
  reason: z.string().max(160),
  finding_id: z.string().nullish(),
});
export type ReviewFocusEntry = z.infer<typeof ReviewFocusEntry>;

/**
 * The structured output of the single model call — and nothing more, so the
 * model cannot emit a score or a `risk_level` [D1].
 *
 * Every cap here is AC-14: `what`/`why` ≤ 400 chars, ≤ 6 risks, ≤ 8 review-focus
 * entries (plus the per-item caps on `BriefRisk` / `ReviewFocusEntry`). A
 * response violating any of them is a parse failure, never persisted.
 */
export const PrBriefGeneration = z.object({
  what: z.string().max(400),
  why: z.string().max(400),
  risks: z.array(BriefRisk).max(6),
  review_focus: z.array(ReviewFocusEntry).max(8),
});
export type PrBriefGeneration = z.infer<typeof PrBriefGeneration>;

/**
 * The persisted brief content: the SAME shape as the model output, but after
 * grounding (risks/entries may have been dropped, never added — so the AC-14
 * caps still hold). Alias kept distinct so storage code reads intentionally.
 */
export const PrBriefContent = PrBriefGeneration;
export type PrBriefContent = PrBriefGeneration;

// ---- Deterministic header rollup ----

/** Worst verdict across the per-agent-latest reviews, or `not_reviewed` (AC-15, AC-18). */
export const BriefStatus = z.union([Verdict, z.literal('not_reviewed')]);
export type BriefStatus = z.infer<typeof BriefStatus>;

/**
 * Score → risk-level breakpoints. These are the score gauge's OWN thresholds,
 * lifted verbatim from `client/src/vendor/ui/primitives/CircularScore.tsx:14`
 * (`score >= 75 ? --ok : score >= 50 ? --warn : --crit`) so the label and the
 * gauge colour can never disagree (AC-16a). A boundary value belongs to the
 * higher band.
 */
export const RISK_LEVEL_BANDS = { low: 75, medium: 50 } as const;

/**
 * Derive `risk_level` from the deterministic PR score (AC-16a). Pure; null in,
 * null out — WHERE the score is null there is no risk level (AC-18a).
 */
export function riskLevelFromScore(score: number | null): RiskSeverity | null {
  if (score === null) return null;
  if (score >= RISK_LEVEL_BANDS.low) return 'low';
  if (score >= RISK_LEVEL_BANDS.medium) return 'medium';
  return 'high';
}

// ---- Generation state & missing inputs ----

/**
 * Why the prose area of the card looks the way it does. The GET always returns
 * 200 with the deterministic header, so this distinguishes "generated, but the
 * section is empty" (AC-13) from "never generated" (AC-35), "refused, inputs
 * missing" (AC-35) and "generation failed" (AC-36).
 */
export const BriefGenerationState = z.enum([
  'ok',
  'not_generated',
  'unavailable',
  'failed',
]);
export type BriefGenerationState = z.infer<typeof BriefGenerationState>;

/** `reason` is a human-readable explanation, null when `state` is `ok`. */
export const PrBriefGenerationStatus = z.object({
  state: BriefGenerationState,
  reason: z.string().nullable(),
});
export type PrBriefGenerationStatus = z.infer<typeof PrBriefGenerationStatus>;

/** An input the generation could not consult, reported honestly (AC-32, AC-33, AC-34, NFR-3). */
export const BriefMissingInput = z.object({
  input: z.string(),
  reason: z.string(),
});
export type BriefMissingInput = z.infer<typeof BriefMissingInput>;

// ---- API response ----

/**
 * What the brief card consumes — served by GET/POST `/pulls/:id/brief`.
 *
 * Nullability convention: `.nullable()` = the key is always present and may be
 * null (deterministic fields the card branches on); `.nullish()` = genuinely
 * optional provenance that may be absent entirely.
 */
export const PrBriefDetail = z.object({
  pr_id: z.string(),

  // Model content (null when nothing has been generated yet).
  what: z.string().max(400).nullable(),
  why: z.string().max(400).nullable(),
  risks: z.array(BriefRisk).max(6),
  review_focus: z.array(ReviewFocusEntry).max(8),

  // Deterministic rollup — never model-influenced [D1] [D2].
  score: z.number().int().min(0).max(100).nullable(),
  risk_level: RiskSeverity.nullable(),
  status: BriefStatus,
  findings_count: z.number().int(),
  blockers: z.number().int(),
  cost_usd: z.number().nullable(),
  tokens_in: z.number().int().nullable(),
  tokens_out: z.number().int().nullable(),

  missing_inputs: z.array(BriefMissingInput),

  // Provenance of the cached generation.
  model: z.string().nullish(),
  head_sha: z.string().nullish(),
  generated_at: z.string().nullish(),

  // Computed per read: the PR state moved since the brief was generated (AC-4, AC-5).
  stale: z.boolean(),
  stale_reason: z.string().nullable(),

  generation: PrBriefGenerationStatus,
});
export type PrBriefDetail = z.infer<typeof PrBriefDetail>;
