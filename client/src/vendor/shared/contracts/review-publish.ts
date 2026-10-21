import { z } from 'zod';
import { ReviewRecordWithActor } from './actors.js';
import { GITLAB_COMMENT_MAX_CHARS } from './host-comments.js';
import { RepoProvider } from './repo-host.js';

/**
 * Publish review findings to a GitLab MR as one batch review (draft notes +
 * `bulk_publish`). Spec `specs/2026-10-21-gitlab-publish-findings.md`
 * ("Contracts"). ADDITIVE — no existing contract file is edited; the review
 * read shape is `.extend`ed here.
 */

// ---- Limits ----
/** Max findings per publish request (AC-20). */
export const PUBLISH_MAX_FINDINGS = 50;
/** Max characters of the optional review summary (AC-20). */
export const PUBLISH_SUMMARY_MAX_CHARS = 10_000;
/** Max characters of one composed note body, marker + footer included (AC-18). */
export const PUBLISH_BODY_MAX_CHARS = GITLAB_COMMENT_MAX_CHARS;
/** Max line span of an applicable `suggestion:-N+0` block (AC-17). */
export const PUBLISH_SUGGESTION_MAX_SPAN = 100;

// ---- Review read shape (AC-1) ----
/**
 * A review plus the head SHA of the diff it actually reviewed. Optional
 * (`nullish`) so pre-existing rows and older payloads still parse.
 */
export const ReviewRecordWithHead = ReviewRecordWithActor.extend({
  head_sha: z.string().nullish(),
});
export type ReviewRecordWithHead = z.infer<typeof ReviewRecordWithHead>;

// ---- Enums ----
/** Review-level reasons the whole review cannot be published (AC-3 – AC-8). */
export const PublishBlockerCode = z.enum([
  'provider_not_supported',
  'review_head_unknown',
  'review_diff_outdated',
  'publish_in_progress',
  'pr_not_open',
  'gitlab_token_missing',
  'gitlab_token_insufficient_scope',
  'gitlab_token_invalid',
]);
export type PublishBlockerCode = z.infer<typeof PublishBlockerCode>;

/**
 * Per-finding reasons a finding cannot be selected (AC-2). Off-diff findings
 * are publishable and described by `anchor.off_diff_reason` instead (D-6).
 */
export const FindingUnpublishableReason = z.enum([
  'body_too_long',
  'dismissed',
  'already_published',
  'publish_unconfirmed',
]);
export type FindingUnpublishableReason = z.infer<typeof FindingUnpublishableReason>;

/**
 * `ApiErrorBody.code` of the publish routes and the publication / item `code`.
 * The 14 publish codes plus the 5 reused GitLab token / project codes, as one
 * enum so the client can key its message table on it.
 */
export const PublishErrorCode = z.enum([
  'publish_selection_invalid',
  'publish_summary_invalid',
  'finding_not_publishable',
  'finding_already_published',
  'publish_in_progress',
  'provider_not_supported',
  'review_head_unknown',
  'review_diff_outdated',
  'pr_not_open',
  'gitlab_drafts_left_behind',
  'gitlab_position_rejected',
  'gitlab_rate_limited',
  'gitlab_publish_failed',
  'gitlab_publish_unconfirmed',
  // Reused codes.
  'gitlab_token_missing',
  'gitlab_token_invalid',
  'gitlab_token_insufficient_scope',
  'gitlab_token_unverified',
  'gitlab_project_inaccessible',
]);
export type PublishErrorCode = z.infer<typeof PublishErrorCode>;

export const PublicationStatus = z.enum([
  'in_progress',
  'published',
  'partially_published',
  'failed',
  'unconfirmed',
]);
export type PublicationStatus = z.infer<typeof PublicationStatus>;

export const PublicationItemState = z.enum([
  'pending',
  'drafted',
  'published',
  'failed',
  'rolled_back',
]);
export type PublicationItemState = z.infer<typeof PublicationItemState>;

export const PublishAnchorKind = z.enum(['multi_line', 'single_line', 'general']);
export type PublishAnchorKind = z.infer<typeof PublishAnchorKind>;

export const OffDiffReason = z.enum(['not_on_diff_line', 'patch_unavailable']);
export type OffDiffReason = z.infer<typeof OffDiffReason>;

// ---- Shapes ----
/** The planned placement of one finding's note (AC-9 – AC-11). */
export const PublishAnchor = z.object({
  kind: PublishAnchorKind,
  path: z.string(),
  start_line: z.number().int(),
  end_line: z.number().int(),
  off_diff_reason: OffDiffReason.nullable(),
});
export type PublishAnchor = z.infer<typeof PublishAnchor>;

/** `{ id, name }` of the user who published / started a publication. */
export const PublishActor = z.object({
  id: z.string(),
  name: z.string(),
});
export type PublishActor = z.infer<typeof PublishActor>;

/** Where a published finding landed on GitLab (AC-26, AC-27). */
export const PublishedLink = z.object({
  discussion_id: z.string().nullable(),
  note_id: z.number().int().nullable(),
  /** https only; null when the note could not be found ("link unavailable"). */
  url: z.string().url().startsWith('https://').nullable(),
  published_at: z.string(),
  published_by: PublishActor.nullable(),
  publication_id: z.string(),
});
export type PublishedLink = z.infer<typeof PublishedLink>;

export const PublishPreviewFinding = z.object({
  finding_id: z.string(),
  publishable: z.boolean(),
  reason: FindingUnpublishableReason.nullable(),
  anchor: PublishAnchor,
  /** Every AC-17 precondition except the "apply suggestions" toggle. */
  suggestion_eligible: z.boolean(),
  published: PublishedLink.nullable(),
});
export type PublishPreviewFinding = z.infer<typeof PublishPreviewFinding>;

export const PublishBlocker = z.object({
  code: PublishBlockerCode,
  message: z.string(),
  /** The running publication (only for `publish_in_progress`). */
  publication_id: z.string().optional(),
});
export type PublishBlocker = z.infer<typeof PublishBlocker>;

/** `GET /reviews/:id/publish-preview` (AC-2). Makes no GitLab request. */
export const PublishPreview = z.object({
  review_id: z.string(),
  provider: RepoProvider,
  mr_iid: z.number().int().nullable(),
  /** Derived from the same route-policy row that guards the publish route (AC-40). */
  viewer_can_publish: z.boolean(),
  blockers: z.array(PublishBlocker),
  findings: z.array(PublishPreviewFinding),
});
export type PublishPreview = z.infer<typeof PublishPreview>;

/** `GET /reviews/:id/publish-other-drafts`. null ⇒ could not be read (fallback warning). */
export const OtherDraftsCount = z.object({
  other_drafts: z.number().int().min(0).nullable(),
});
export type OtherDraftsCount = z.infer<typeof OtherDraftsCount>;

/**
 * `POST /reviews/:id/publications` body (AC-20). Uniqueness and the
 * whitespace-only summary check are a top-level `superRefine` reporting path
 * `finding_ids` / `summary`, which the service maps to its error code. Keep the
 * refinement outermost — do not `.extend` this schema.
 */
export const PublishRequest = z
  .object({
    finding_ids: z.array(z.string().uuid()).min(1).max(PUBLISH_MAX_FINDINGS),
    summary: z.string().max(PUBLISH_SUMMARY_MAX_CHARS).optional(),
    apply_suggestions: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.finding_ids).size !== value.finding_ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['finding_ids'],
        message: 'finding_ids must be unique',
      });
    }
    if (value.summary !== undefined && value.summary.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary'],
        message: 'summary must not be whitespace-only',
      });
    }
  });
export type PublishRequest = z.infer<typeof PublishRequest>;
export type PublishRequestInput = z.input<typeof PublishRequest>;

export const PublicationItem = z.object({
  finding_id: z.string(),
  state: PublicationItemState,
  code: z.string().nullable(),
  link: PublishedLink.nullable(),
});
export type PublicationItem = z.infer<typeof PublicationItem>;

/** The `202` response of a publish and the status read (AC-21, AC-39). */
export const Publication = z.object({
  id: z.string(),
  review_id: z.string(),
  pr_id: z.string(),
  status: PublicationStatus,
  code: PublishErrorCode.nullable(),
  message: z.string().nullable(),
  requested: z.number().int().min(0),
  drafted: z.number().int().min(0),
  published: z.number().int().min(0),
  failed: z.number().int().min(0),
  general_notes: z.number().int().min(0),
  other_drafts_published: z.number().int().min(0),
  has_summary: z.boolean(),
  apply_suggestions: z.boolean(),
  created_by: PublishActor.nullable(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
  items: z.array(PublicationItem),
});
export type Publication = z.infer<typeof Publication>;

/** Strict `review.publish` audit metadata — counts and ids only, never bodies (AC-41). */
export const ReviewPublishAuditMetadata = z
  .object({
    provider: z.literal('gitlab'),
    publication_id: z.string(),
    pr_id: z.string(),
    outcome: PublicationStatus.exclude(['in_progress']),
    requested: z.number().int().min(0),
    published: z.number().int().min(0),
    failed: z.number().int().min(0),
    general_notes: z.number().int().min(0),
    other_drafts_published: z.number().int().min(0),
    applicable_suggestions: z.number().int().min(0),
    has_summary: z.boolean(),
  })
  .strict();
export type ReviewPublishAuditMetadata = z.infer<typeof ReviewPublishAuditMetadata>;
