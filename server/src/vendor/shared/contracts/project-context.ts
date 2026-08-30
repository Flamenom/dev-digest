import { z } from 'zod';

/**
 * Project Context — discovery and management of a repo's project documents
 * (specs / docs / insights) that can be attached to agents and skills.
 */

/** Which top-level bucket a discovered document belongs to. */
export const DocumentBucket = z.enum(['specs', 'docs', 'insights']);
export type DocumentBucket = z.infer<typeof DocumentBucket>;

/** One project document discovered in the repo clone. Discovery walks the
 *  WHOLE tree for `.md` files (skipping `.git`/`node_modules`/`.claude`);
 *  `bucket` is null for documents outside every bucket directory. */
export const DiscoveredDocument = z.object({
  path: z.string(),
  bucket: DocumentBucket.nullable(),
  estimated_tokens: z.number().int(),
  used_by_agents: z.number().int().optional(),
});
export type DiscoveredDocument = z.infer<typeof DiscoveredDocument>;

/** Summary of the latest discovery pass over the repo clone. */
export const DiscoverySummary = z.object({
  document_count: z.number().int(),
  total_estimated_tokens: z.number().int(),
  refreshed_at: z.string(), // ISO timestamp
  clone_available: z.boolean(),
});
export type DiscoverySummary = z.infer<typeof DiscoverySummary>;

/** Full text of one project document. */
export const DocumentContent = z.object({
  path: z.string(),
  text: z.string(),
});
export type DocumentContent = z.infer<typeof DocumentContent>;

/** Body for setting an agent's/skill's attached docs (ordered). */
export const SetAttachedDocsBody = z.object({
  paths: z.array(z.string()),
});
export type SetAttachedDocsBody = z.infer<typeof SetAttachedDocsBody>;

/** Body for saving a project document's text. */
export const SaveDocumentBody = z.object({
  path: z.string(),
  text: z.string(),
});
export type SaveDocumentBody = z.infer<typeof SaveDocumentBody>;
