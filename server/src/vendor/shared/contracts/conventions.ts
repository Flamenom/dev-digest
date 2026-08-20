import { z } from 'zod';

/**
 * L02 — Conventions Extractor (Skills Lab).
 *
 * EXTENDS the frozen ConventionCandidate (contracts/knowledge.ts): that schema
 * stays untouched; this file is additive per the vendored-contracts rule.
 * The extractor samples the cloned repo, asks a cheap model for candidate
 * house-rules, then grounds each candidate's evidence against the sampled
 * files — ungrounded candidates are dropped before persisting.
 */
export const ConventionCategory = z.enum([
  'naming',
  'structure',
  'imports',
  'error-handling',
  'typing',
  'testing',
  'styling',
  'api-design',
  'other',
]);
export type ConventionCategory = z.infer<typeof ConventionCategory>;

export const ConventionStatus = z.enum(['pending', 'accepted', 'rejected']);
export type ConventionStatus = z.infer<typeof ConventionStatus>;

export const Convention = z.object({
  id: z.string(),
  repo_id: z.string(),
  category: ConventionCategory,
  rule: z.string(),
  evidence_path: z.string(),
  evidence_snippet: z.string(),
  /** 1-based, inclusive. Nullish when the snippet matched but lines could not be resolved. */
  evidence_start_line: z.number().int().nullish(),
  evidence_end_line: z.number().int().nullish(),
  confidence: z.number().min(0).max(1),
  status: ConventionStatus,
  created_at: z.string(),
});
export type Convention = z.infer<typeof Convention>;

/** Meta for "Detected from N sample files · last scan Xh ago". */
export const ConventionScanStats = z.object({
  sampledFileCount: z.number().int(),
  /** Candidates dropped by the grounding gate on the last scan. */
  droppedCount: z.number().int(),
  lastScanAt: z.string(),
});
export type ConventionScanStats = z.infer<typeof ConventionScanStats>;

export const ConventionListResponse = z.object({
  conventions: z.array(Convention),
  /** Nullish until the first extraction has run for the repo. */
  stats: ConventionScanStats.nullish(),
});
export type ConventionListResponse = z.infer<typeof ConventionListResponse>;

export const ConventionExtractResponse = z.object({
  conventions: z.array(Convention),
  stats: ConventionScanStats,
});
export type ConventionExtractResponse = z.infer<typeof ConventionExtractResponse>;

export const UpdateConventionBody = z.object({
  status: ConventionStatus.optional(),
  rule: z.string().min(1).optional(),
});
export type UpdateConventionBody = z.infer<typeof UpdateConventionBody>;

export const BulkConventionStatusBody = z.object({
  status: ConventionStatus,
});
export type BulkConventionStatusBody = z.infer<typeof BulkConventionStatusBody>;
