import { z } from 'zod';
import {
  OffDiffReason,
  OtherDraftsCount,
  PUBLISH_MAX_FINDINGS,
  Publication,
  PublicationItem,
  PublishAnchor,
  PublishAnchorKind,
  PublishPreview,
  PublishPreviewFinding,
  PublishedLink,
  ReviewPublishAuditMetadata,
} from './review-publish.js';

/**
 * Publish findings from an outdated review run, marked "deprecated". Spec
 * `specs/2026-10-23-gitlab-publish-outdated-findings.md` ("Contracts").
 * ADDITIVE — `review-publish.ts` is not edited; its shapes are widened here
 * with `.extend` into parallel `…WithDeprecation` schemas.
 */

// ---- Limits ----
/** Max pages of `GET …/merge_requests/:iid/versions`; beyond ⇒ version not found (NFR). */
export const PUBLISH_VERSIONS_MAX_PAGES = 20;

// ---- Enums ----
/** Why a run is deprecated (AC-1, AC-3). */
export const DeprecationReason = z.enum(['head_moved', 'head_unknown']);
export type DeprecationReason = z.infer<typeof DeprecationReason>;

/** Base anchor kinds plus `deferred` — placement decided at publish (AC-19). */
export const PublishAnchorKindAll = z.enum([...PublishAnchorKind.options, 'deferred']);
export type PublishAnchorKindAll = z.infer<typeof PublishAnchorKindAll>;

/** Base off-diff reasons plus the three deprecated-run reasons (AC-8, AC-9, AC-12). */
export const OffDiffReasonAll = z.enum([
  ...OffDiffReason.options,
  'reviewed_version_unavailable',
  'review_head_unknown',
  'position_rejected',
]);
export type OffDiffReasonAll = z.infer<typeof OffDiffReasonAll>;

// ---- Shapes ----
/** Review-level deprecation, computed from persisted state only (AC-1). */
export const PublishDeprecation = z.object({
  reason: DeprecationReason,
  reviewed_head_sha: z.string().nullable(),
});
export type PublishDeprecation = z.infer<typeof PublishDeprecation>;

/** Deprecation computed from the live diff refs (publish plan, AC-21). */
export const PublishLiveDeprecation = PublishDeprecation.extend({
  live_head_sha: z.string(),
});
export type PublishLiveDeprecation = z.infer<typeof PublishLiveDeprecation>;

export const PublishAnchorWithDeprecation = PublishAnchor.extend({
  kind: PublishAnchorKindAll,
  off_diff_reason: OffDiffReasonAll.nullable(),
});
export type PublishAnchorWithDeprecation = z.infer<typeof PublishAnchorWithDeprecation>;

/** A published link that also says whether it was published as deprecated (AC-24). */
export const PublishedLinkWithDeprecation = PublishedLink.extend({
  deprecated: z.boolean().optional(),
});
export type PublishedLinkWithDeprecation = z.infer<typeof PublishedLinkWithDeprecation>;

export const PublishPreviewFindingWithDeprecation = PublishPreviewFinding.extend({
  anchor: PublishAnchorWithDeprecation,
  published: PublishedLinkWithDeprecation.nullable(),
});
export type PublishPreviewFindingWithDeprecation = z.infer<
  typeof PublishPreviewFindingWithDeprecation
>;

/** `GET /reviews/:id/publish-preview` with the review-level deprecation (AC-1). */
export const PublishPreviewWithDeprecation = PublishPreview.extend({
  deprecation: PublishDeprecation.nullable(),
  findings: z.array(PublishPreviewFindingWithDeprecation),
});
export type PublishPreviewWithDeprecation = z.infer<typeof PublishPreviewWithDeprecation>;

/**
 * `GET /reviews/:id/publish-plan?finding_ids=<uuid>,<uuid>…` query (AC-21).
 * The comma-separated list is split + trimmed, then validated like the
 * publish selection (1..PUBLISH_MAX_FINDINGS unique uuids).
 */
export const PublishPlanQuery = z.object({
  finding_ids: z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id.length > 0)
        : value,
    z
      .array(z.string().uuid())
      .min(1)
      .max(PUBLISH_MAX_FINDINGS)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'finding_ids must be unique',
      }),
  ),
});
export type PublishPlanQuery = z.infer<typeof PublishPlanQuery>;
export type PublishPlanQueryInput = z.input<typeof PublishPlanQuery>;

/** Read-only publish plan shown in the confirm dialog (AC-21). Never writes. */
export const PublishPlan = OtherDraftsCount.extend({
  plan_available: z.boolean(),
  deprecation: PublishLiveDeprecation.nullable().optional(),
  placement: z
    .object({
      positioned: z.number().int().min(0),
      general: z.number().int().min(0),
    })
    .nullable(),
});
export type PublishPlan = z.infer<typeof PublishPlan>;

/**
 * Parsed from the same raw publish body AFTER `PublishRequest` (which must not
 * be `.extend`ed — its refinement is outermost). AC-4.
 */
export const PublishAcknowledgement = z.object({
  acknowledge_deprecated: z.boolean().default(false),
});
export type PublishAcknowledgement = z.infer<typeof PublishAcknowledgement>;
export type PublishAcknowledgementInput = z.input<typeof PublishAcknowledgement>;

export const PublicationItemWithDeprecation = PublicationItem.extend({
  link: PublishedLinkWithDeprecation.nullable(),
});
export type PublicationItemWithDeprecation = z.infer<typeof PublicationItemWithDeprecation>;

/** The publication shape with the deprecation fields (AC-25). */
export const PublicationWithDeprecation = Publication.extend({
  deprecated: z.boolean(),
  deprecation_reason: DeprecationReason.nullable(),
  /** null when no version lookup happened. */
  reviewed_version_found: z.boolean().nullable(),
  position_fallbacks: z.number().int().min(0),
  items: z.array(PublicationItemWithDeprecation),
});
export type PublicationWithDeprecation = z.infer<typeof PublicationWithDeprecation>;

/** Strict `review.publish` audit metadata + the 4 deprecation fields; no SHA, no body (AC-26). */
export const ReviewPublishAuditMetadataWithDeprecation = ReviewPublishAuditMetadata.extend({
  deprecated: z.boolean(),
  deprecation_reason: DeprecationReason.nullable(),
  reviewed_version_found: z.boolean().nullable(),
  position_fallbacks: z.number().int().min(0),
}).strict();
export type ReviewPublishAuditMetadataWithDeprecation = z.infer<
  typeof ReviewPublishAuditMetadataWithDeprecation
>;
