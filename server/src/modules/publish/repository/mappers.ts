/**
 * Row → domain mapping for the publish repository (plan T7). Infrastructure
 * ring: the ONLY place `review_publications` / `review_publication_items` /
 * `findings` row shapes are turned into the `ports.ts` domain types, so no
 * `$inferSelect` escapes the repository (onion §5).
 *
 * Text columns that hold contract enums are narrowed through the contract's own
 * literal lists; an unknown value never crashes a read.
 */
import {
  DeprecationReason,
  FindingKind,
  PrStatus,
  PublicationItemState,
  PublicationStatus,
  PublishAnchorKindAll,
  PublishErrorCode,
  Severity,
  type PublishActor,
} from '@devdigest/shared';
import type * as t from '../../../db/schema.js';
import type {
  PersistedFileLike,
  PublicationItemRecord,
  PublicationRecord,
  PublishFindingRow,
} from '../ports.js';

export type PublicationRow = typeof t.reviewPublications.$inferSelect;
export type PublicationItemRow = typeof t.reviewPublicationItems.$inferSelect;
export type FindingDbRow = typeof t.findings.$inferSelect;
export type PrFileDbRow = typeof t.prFiles.$inferSelect;

const oneOf =
  <T extends string>(values: readonly T[]) =>
  (value: string | null | undefined): value is T =>
    value != null && (values as readonly string[]).includes(value);

const isSeverity = oneOf(Severity.options);
const isFindingKind = oneOf(FindingKind.options);
const isPrStatus = oneOf(PrStatus.options);
const isPublicationStatus = oneOf(PublicationStatus.options);
const isItemState = oneOf(PublicationItemState.options);
const isAnchorKind = oneOf(PublishAnchorKindAll.options);
const isDeprecationReason = oneOf(DeprecationReason.options);
const isPublishErrorCode = oneOf(PublishErrorCode.options);

/**
 * Persisted PR state → contract `PrStatus`. An unknown value maps to `closed`
 * (fail closed: the preview then blocks with `pr_not_open` instead of
 * publishing to a PR whose state we cannot read).
 */
export function toPrStatus(value: string): PrStatus {
  return isPrStatus(value) ? value : 'closed';
}

/** Unknown severities (none are written today) read as the mildest one. */
export function toFindingRow(row: FindingDbRow): PublishFindingRow {
  return {
    id: row.id,
    severity: isSeverity(row.severity) ? row.severity : 'SUGGESTION',
    category: row.category,
    title: row.title,
    file: row.file,
    start_line: row.startLine,
    end_line: row.endLine,
    rationale: row.rationale,
    suggestion: row.suggestion,
    kind: isFindingKind(row.kind) ? row.kind : null,
    // Trifecta evidence is not persisted (reviews/helpers.ts maps it to null too).
    evidence: null,
    dismissed_at: row.dismissedAt,
  };
}

export function toPersistedFile(row: PrFileDbRow): PersistedFileLike {
  return {
    path: row.path,
    patch: row.patch,
    previousPath: row.previousPath,
    patchOmitted: row.patchOmitted,
    changeType: row.changeType,
  };
}

/** `null` for an unknown/missing code (never surfaces a value outside the contract). */
export function toPublishErrorCode(value: string | null): PublishErrorCode | null {
  return isPublishErrorCode(value) ? value : null;
}

export function toPublicationStatus(value: string): PublicationStatus {
  // The DB CHECK guarantees membership; the fallback is unreachable defence.
  return isPublicationStatus(value) ? value : 'unconfirmed';
}

export function toItemState(value: string): PublicationItemState {
  return isItemState(value) ? value : 'failed';
}

/** Includes `deferred` (migration 0028, outdated-findings Q7). */
export function toAnchorKind(value: string): PublishAnchorKindAll {
  return isAnchorKind(value) ? value : 'general';
}

/** `null` for a missing / unknown reason (the DB CHECK makes the fallback unreachable). */
export function toDeprecationReason(value: string | null): DeprecationReason | null {
  return isDeprecationReason(value) ? value : null;
}

export function toItemRecord(row: PublicationItemRow): PublicationItemRecord {
  return {
    findingId: row.findingId,
    position: row.position,
    state: toItemState(row.state),
    code: row.code,
    anchorKind: toAnchorKind(row.anchorKind),
    draftId: row.draftId,
    discussionId: row.discussionId,
    noteId: row.noteId,
    url: row.url,
    publishedAt: row.publishedAt,
  };
}

export function toActor(id: string | null, name: string | null): PublishActor | null {
  return id && name != null ? { id, name } : null;
}

export function toPublicationRecord(
  row: PublicationRow,
  createdBy: PublishActor | null,
  items: readonly PublicationItemRow[],
): PublicationRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    reviewId: row.reviewId,
    prId: row.prId,
    createdBy,
    status: toPublicationStatus(row.status),
    code: toPublishErrorCode(row.code),
    message: row.message,
    requested: row.requested,
    drafted: row.drafted,
    published: row.published,
    failed: row.failed,
    generalNotes: row.generalNotes,
    applicableSuggestions: row.applicableSuggestions,
    otherDraftsPublished: row.otherDraftsPublished,
    hasSummary: row.hasSummary,
    applySuggestions: row.applySuggestions,
    diffHeadSha: row.diffHeadSha,
    // DB CHECK `review_publications_deprecation_ck`: deprecated ⇔ reason set.
    deprecated: row.deprecated,
    deprecationReason: row.deprecated ? toDeprecationReason(row.deprecationReason) : null,
    reviewedVersionFound: row.reviewedVersionFound,
    positionFallbacks: row.positionFallbacks,
    bulkPublishSentAt: row.bulkPublishSentAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
    items: [...items].sort((a, b) => a.position - b.position).map(toItemRecord),
  };
}
