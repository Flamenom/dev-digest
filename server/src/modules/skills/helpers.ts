import type { Skill, SkillSource, SkillType, SkillVersionEntry } from '@devdigest/shared';
import type { SkillRow, SkillVersionRow } from './repository.js';

/**
 * Pure helpers for the skills module — DB row ⇄ DTO mapping and the
 * body-version-bump rule (the skills analogue of the agents module's
 * config-vs-enabled split). No I/O.
 */

/** Map a persisted skill row to the public `Skill` DTO. */
export function toSkillDto(row: SkillRow): Skill {
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
  };
}

/** Map a persisted `skill_versions` row to the public `SkillVersionEntry` DTO. */
export function toSkillVersionDto(row: SkillVersionRow): SkillVersionEntry {
  return {
    skill_id: row.skillId,
    version: row.version,
    note: row.note ?? null,
    body: row.body,
    created_at: row.createdAt.toISOString(),
  };
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
