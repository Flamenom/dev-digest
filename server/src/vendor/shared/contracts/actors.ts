import { z } from 'zod';
import { RunSummary } from './trace.js';
import { FindingRecord, ReviewRecord } from './review-api.js';
import { EvalCaseRecord } from './eval-pipeline.js';
import { Agent, AgentVersion, Skill } from './knowledge.js';
import { SkillVersionEntry } from './skills-usage.js';

/**
 * Multi-user server mode — audit attribution (AC-45–AC-49). ADDITIVE: the
 * frozen DTOs are `.extend`ed here, never edited. Every actor field is
 * OPTIONAL (`ActorRef.optional()` ⇒ the key may be absent, null or a ref), so
 * existing fixtures and older payloads keep parsing.
 *
 * Rendering (Q3): a ref with `is_system: true` is the seeded local user →
 * "Local user"; a null/absent ref → "—".
 */

export const ActorRefValue = z.object({
  user_id: z.string(),
  name: z.string(),
  /** True for the seeded system user (local mode / pre-multi-user rows). */
  is_system: z.boolean().optional(),
});
export type ActorRefValue = z.infer<typeof ActorRefValue>;

/** `{ user_id, name, is_system? } | null`. */
export const ActorRef = ActorRefValue.nullable();
export type ActorRef = z.infer<typeof ActorRef>;

// ---- Runs / reviews / findings ----
export const RunSummaryWithActor = RunSummary.extend({
  started_by: ActorRef.optional(),
});
export type RunSummaryWithActor = z.infer<typeof RunSummaryWithActor>;

/** Latest accept/dismiss actor (every action is still audited separately). */
export const FindingRecordWithActor = FindingRecord.extend({
  acted_by: ActorRef.optional(),
});
export type FindingRecordWithActor = z.infer<typeof FindingRecordWithActor>;

export const ReviewRecordWithActor = ReviewRecord.extend({
  started_by: ActorRef.optional(),
  findings: z.array(FindingRecordWithActor),
});
export type ReviewRecordWithActor = z.infer<typeof ReviewRecordWithActor>;

// ---- Eval ----
export const EvalCaseRecordWithActor = EvalCaseRecord.extend({
  created_by: ActorRef.optional(),
});
export type EvalCaseRecordWithActor = z.infer<typeof EvalCaseRecordWithActor>;

// ---- Agents ----
export const AgentWithActors = Agent.extend({
  created_by: ActorRef.optional(),
  updated_by: ActorRef.optional(),
});
export type AgentWithActors = z.infer<typeof AgentWithActors>;

export const AgentVersionWithAuthor = AgentVersion.extend({
  author: ActorRef.optional(),
});
export type AgentVersionWithAuthor = z.infer<typeof AgentVersionWithAuthor>;

// ---- Skills ----
export const SkillWithActors = Skill.extend({
  created_by: ActorRef.optional(),
  updated_by: ActorRef.optional(),
});
export type SkillWithActors = z.infer<typeof SkillWithActors>;

/** GET /skills/:id/versions entry (`SkillVersionEntry`) plus its author. */
export const SkillVersionEntryWithAuthor = SkillVersionEntry.extend({
  author: ActorRef.optional(),
});
export type SkillVersionEntryWithAuthor = z.infer<typeof SkillVersionEntryWithAuthor>;
