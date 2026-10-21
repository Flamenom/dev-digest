/* Test fixtures for the publish-findings component tests (not shipped). */
import type { Publication, PublishPreviewFinding } from "@/lib/types";

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
