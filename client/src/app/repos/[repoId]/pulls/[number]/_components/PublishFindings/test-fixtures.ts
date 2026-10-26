/* Test fixtures for the publish-findings component tests (not shipped). */
import type {
  DeprecationReason,
  Publication,
  PublicationWithDeprecation,
  PublishPlan,
  PublishPreviewFinding,
  PublishPreviewFindingWithDeprecation,
  PublishPreviewWithDeprecation,
} from "@/lib/types";

export function previewEntry(id: string, overrides: Partial<PublishPreviewFinding> = {}): PublishPreviewFinding {
  return {
    finding_id: id,
    publishable: true,
    reason: null,
    anchor: { kind: "single_line", path: "src/app.ts", start_line: 10, end_line: 12, off_diff_reason: null },
    suggestion_eligible: false,
    published: null,
    ...overrides,
  };
}

export function publication(overrides: Partial<Publication> = {}): Publication {
  return {
    id: "pub-1",
    review_id: "rev-1",
    pr_id: "pr-1",
    status: "in_progress",
    code: null,
    message: null,
    requested: 3,
    drafted: 1,
    published: 0,
    failed: 0,
    general_notes: 0,
    other_drafts_published: 0,
    has_summary: false,
    apply_suggestions: false,
    created_by: null,
    created_at: "2026-10-21T10:00:00.000Z",
    finished_at: null,
    items: [],
    ...overrides,
  };
}

// ---- outdated ("deprecated") runs — spec 2026-10-23-gitlab-publish-outdated-findings ----

/** Reviewed head of the deprecated fixtures (lowercase hex). */
export const REVIEWED_SHA = "abcdef1234567890abcdef1234567890abcdef12";
/** Live MR head after the review (lowercase hex). */
export const LIVE_SHA = "0123456789abcdef0123456789abcdef01234567";

/** A preview entry whose placement is decided at publish (`head_moved`, AC-19). */
export function deferredEntry(
  id: string,
  overrides: Partial<PublishPreviewFindingWithDeprecation> = {},
): PublishPreviewFindingWithDeprecation {
  return {
    ...previewEntry(id),
    anchor: { kind: "deferred", path: "src/app.ts", start_line: 10, end_line: 12, off_diff_reason: null },
    suggestion_eligible: false,
    ...overrides,
  };
}

/**
 * A deprecated preview (AC-1, AC-19): `head_moved` → deferred anchors;
 * `head_unknown` → general anchors with `review_head_unknown`. No blockers (AC-2).
 */
export function deprecatedPreview(
  reason: DeprecationReason = "head_moved",
  ids: readonly string[] = ["f-1", "f-2"],
  overrides: Partial<PublishPreviewWithDeprecation> = {},
): PublishPreviewWithDeprecation {
  return {
    review_id: "rev-1",
    provider: "gitlab",
    mr_iid: 7,
    viewer_can_publish: true,
    blockers: [],
    deprecation: { reason, reviewed_head_sha: reason === "head_moved" ? REVIEWED_SHA : null },
    findings: ids.map((id) =>
      reason === "head_moved"
        ? deferredEntry(id)
        : deferredEntry(id, {
            anchor: {
              kind: "general",
              path: "src/app.ts",
              start_line: 10,
              end_line: 12,
              off_diff_reason: "review_head_unknown",
            },
          }),
    ),
    ...overrides,
  };
}

/** A publish plan (AC-21); defaults to a `head_moved` run with 1 of 2 findings general. */
export function publishPlan(overrides: Partial<PublishPlan> = {}): PublishPlan {
  return {
    other_drafts: 0,
    plan_available: true,
    deprecation: { reason: "head_moved", reviewed_head_sha: REVIEWED_SHA, live_head_sha: LIVE_SHA },
    placement: { positioned: 1, general: 1 },
    ...overrides,
  };
}

/** A finished deprecated publication (AC-24, AC-25). */
export function deprecatedPublication(
  overrides: Partial<PublicationWithDeprecation> = {},
): PublicationWithDeprecation {
  return {
    ...publication({ status: "published", drafted: 3, published: 3, finished_at: "2026-10-21T10:01:00.000Z" }),
    deprecated: true,
    deprecation_reason: "head_moved",
    reviewed_version_found: true,
    position_fallbacks: 0,
    items: [],
    ...overrides,
  };
}
