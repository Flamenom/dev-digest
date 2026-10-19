import type {
  Skill,
  SkillSource,
  SkillType,
  SkillVersionEntry,
  SkillVersionEntryWithAuthor,
  SkillWithActors,
} from '@devdigest/shared';
import { withActors, type ActorLookup } from '../_shared/actors.js';
import type { SkillRow, SkillVersionRow } from './repository.js';

/**
 * Pure helpers for the skills module — DB row ⇄ DTO mapping and the
 * body-version-bump rule (the skills analogue of the agents module's
 * config-vs-enabled split). No I/O.
 */

/**
 * Service-level skill DTO: the public `Skill` plus the RAW actor ids (AC-47).
 * The ids are internal — routes resolve them to `ActorRef`s and strip them
 * via `toSkillResponses` before anything reaches the wire.
 */
export type SkillDto = Skill & {
  readonly createdById: string | null;
  readonly updatedById: string | null;
};

/** Service-level version DTO: the public entry plus the raw author id. */
export type SkillVersionDto = SkillVersionEntry & { readonly authorId: string | null };

/** Map a persisted skill row to the service `SkillDto` (public `Skill` + actor ids). */
export function toSkillDto(row: SkillRow): SkillDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type as SkillType,
    source: row.source as SkillSource,
    body: row.body,
    enabled: row.enabled,
    version: row.version,
    evidence_files: row.evidenceFiles ?? null,
    attached_doc_paths: row.attachedDocPaths,
    // `?? null`: legacy rows (pre-0021) and hermetic fakes carry no actor.
    createdById: row.createdBy ?? null,
    updatedById: row.updatedBy ?? null,
  };
}

/** Map a persisted `skill_versions` row to the service `SkillVersionDto`. */
export function toSkillVersionDto(row: SkillVersionRow): SkillVersionDto {
  return {
    skill_id: row.skillId,
    version: row.version,
    note: row.note ?? null,
    body: row.body,
    created_at: row.createdAt.toISOString(),
    authorId: row.authorId ?? null,
  };
}

/**
 * Wire projection (Rec-3): resolve `created_by` / `updated_by` with ONE
 * batched lookup and drop the raw ids. Unknown / null ids → `null` ("—").
 */
export async function toSkillResponses(
  dtos: readonly SkillDto[],
  lookup: ActorLookup,
): Promise<SkillWithActors[]> {
  const enriched = await withActors(
    dtos,
    { created_by: (d) => d.createdById, updated_by: (d) => d.updatedById },
    lookup,
  );
  return enriched.map(({ createdById: _c, updatedById: _u, ...rest }) => rest);
}

export async function toSkillResponse(
  dto: SkillDto,
  lookup: ActorLookup,
): Promise<SkillWithActors> {
  const [one] = await toSkillResponses([dto], lookup);
  return one!;
}

/** Wire projection for version entries: `author` ref, raw `authorId` dropped. */
export async function toSkillVersionResponses(
  dtos: readonly SkillVersionDto[],
  lookup: ActorLookup,
): Promise<SkillVersionEntryWithAuthor[]> {
  const enriched = await withActors(dtos, { author: (d) => d.authorId }, lookup);
  return enriched.map(({ authorId: _a, ...rest }) => rest);
}

/**
 * True when a PUT patch changes the skill BODY relative to the existing row.
 * Only a body change bumps `version` and snapshots `skill_versions` —
 * enabled/name/description/type-only edits do not (mirrors how agents split
 * config-vs-enabled versioning). A "restore" is just a PUT with an old body,
 * which — being different from the current head — creates a NEW head version.
 */
export function isBodyChange(
  existing: Pick<SkillRow, 'body'>,
  patch: { body?: string },
): boolean {
  return patch.body !== undefined && patch.body !== existing.body;
}

// The run-side enabled/disabled split lives in `modules/_shared/skill-prompt.ts`
// (shared with the review run-executor, which must not import this folder).

/** The version note recorded when POST /skills/:id/restore re-applies vN. */
export function restoreNote(version: number): string {
  return `Restored from v${version}`;
}
