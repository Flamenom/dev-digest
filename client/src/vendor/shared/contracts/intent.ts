import { z } from 'zod';
import { Intent } from './brief.js';
import { Finding, Review } from './findings.js';

/**
 * L03 — Intent Layer (spec 04).
 *
 * EXTENDS the frozen `Intent` (contracts/brief.ts — its summary field is named
 * `intent`) and `Finding`/`Review` (contracts/findings.ts): those schemas stay
 * untouched; this file is additive per the vendored-contracts rule.
 *
 * A cheap classifier derives a PR's intent + scope from PR metadata and linked
 * sources; the result is persisted per PR, injected into the reviewer prompt,
 * and used to tag/filter out-of-scope findings (one CRITICAL out-of-scope
 * signal always survives).
 */

// ---- Sources the classifier consulted ----
export const IntentSourceKind = z.enum([
  'pr_description',
  'linked_issue',
  'repo_doc',
  'external_url',
]);
export type IntentSourceKind = z.infer<typeof IntentSourceKind>;

/**
 * v1 locked decision: external non-GitHub URLs are never fetched — they are
 * recorded as `unavailable` (honest missing-context marking, never fabricated).
 */
export const IntentSourceStatus = z.enum(['fetched', 'unavailable']);
export type IntentSourceStatus = z.infer<typeof IntentSourceStatus>;

export const IntentSource = z.object({
  kind: IntentSourceKind,
  /** Human-readable reference: 'PR description', '#123', a repo path, or a URL. */
  ref: z.string(),
  title: z.string().nullish(),
  status: IntentSourceStatus,
});
export type IntentSource = z.infer<typeof IntentSource>;

/** Deterministic, computed in code — never model-self-reported. */
export const IntentConfidence = z.enum(['high', 'low']);
export type IntentConfidence = z.infer<typeof IntentConfidence>;

/**
 * The classifier's structured output. `.max()` caps are a hallucination guard:
 * an over-long answer fails parsing and is repaired/retried instead of being
 * persisted. The service maps `summary` → the frozen `intent` field at the
 * boundary.
 */
export const IntentClassification = z.object({
  summary: z.string().min(1).max(500),
  in_scope: z.array(z.string().max(200)).max(8),
  out_of_scope: z.array(z.string().max(200)).max(8),
  risk_areas: z.array(z.string().max(80)).max(6),
});
export type IntentClassification = z.infer<typeof IntentClassification>;

/** API response for GET/POST /pulls/:id/intent. `stale` = head moved since classification. */
export const IntentDetail = Intent.extend({
  pr_id: z.string(),
  risk_areas: z.array(z.string()),
  confidence: IntentConfidence,
  sources: z.array(IntentSource),
  model: z.string().nullish(),
  head_sha: z.string().nullish(),
  generated_at: z.string(),
  stale: z.boolean(),
});
export type IntentDetail = z.infer<typeof IntentDetail>;

/** The persisted projection of IntentDetail (`stale` is computed per read). */
export const StoredIntentDetail = IntentDetail.omit({ stale: true });
export type StoredIntentDetail = z.infer<typeof StoredIntentDetail>;

/**
 * Write payload for the per-PR intent upsert. Tokens/cost come from the LLM
 * `StructuredResult` and are observability-only (persisted, never re-read).
 */
export const IntentDetailWrite = StoredIntentDetail.omit({
  pr_id: true,
  generated_at: true,
}).extend({
  tokens_in: z.number().int().nullish(),
  tokens_out: z.number().int().nullish(),
  cost_usd: z.number().nullish(),
});
export type IntentDetailWrite = z.infer<typeof IntentDetailWrite>;

// ---- Scoped review (reviewer output when intent is present) ----
/**
 * `scope` is tagged by the reviewer model per finding ('in' | 'out'); scope
 * NEVER waives severity. The key is stripped before persistence — the DB/API
 * only ever see frozen `Finding`s.
 */
export const ScopedFinding = Finding.extend({
  scope: z.enum(['in', 'out']).nullish(),
});
export type ScopedFinding = z.infer<typeof ScopedFinding>;

export const ScopedReview = Review.extend({
  findings: z.array(ScopedFinding),
});
export type ScopedReview = z.infer<typeof ScopedReview>;
