/**
 * T1 — outdated-run publish contracts (spec
 * `specs/2026-10-23-gitlab-publish-outdated-findings.md`, AC-1, AC-4, AC-19,
 * AC-21, AC-25, AC-26). Widened shapes live in a new file; the base ones stay
 * unchanged.
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  OffDiffReasonAll,
  PUBLISH_VERSIONS_MAX_PAGES,
  Publication,
  PublicationWithDeprecation,
  PublishAcknowledgement,
  PublishAnchor,
  PublishAnchorWithDeprecation,
  PublishPlan,
  PublishPlanQuery,
  PublishPreview,
  PublishPreviewWithDeprecation,
  PublishedLinkWithDeprecation,
  ReviewPublishAuditMetadataWithDeprecation,
} from '@devdigest/shared';

const anchor = {
  kind: 'single_line' as const,
  path: 'src/a.ts',
  start_line: 3,
  end_line: 3,
  off_diff_reason: null,
};

const preview = {
  review_id: 'r1',
  provider: 'gitlab' as const,
  mr_iid: 1,
  viewer_can_publish: true,
  blockers: [],
  findings: [
    {
      finding_id: 'f1',
      publishable: true,
      reason: null,
      anchor,
      suggestion_eligible: false,
      published: null,
    },
  ],
};

const link = {
  discussion_id: 'd1',
  note_id: 7,
  url: 'https://gitlab.com/g/p/-/merge_requests/1#note_7',
  published_at: '2026-10-23T00:00:00.000Z',
  published_by: { id: 'u1', name: 'Ada' },
  publication_id: 'pub1',
};

const publication = {
  id: 'pub1',
  review_id: 'r1',
  pr_id: 'p1',
  status: 'published' as const,
  code: null,
  message: null,
  requested: 1,
  drafted: 1,
  published: 1,
  failed: 0,
  general_notes: 0,
  other_drafts_published: 0,
  has_summary: false,
  apply_suggestions: false,
  created_by: null,
  created_at: '2026-10-23T00:00:00.000Z',
  finished_at: null,
  items: [{ finding_id: 'f1', state: 'published' as const, code: null, link }],
};

const deprecationFields = {
  deprecated: true,
  deprecation_reason: 'head_moved' as const,
  reviewed_version_found: true,
  position_fallbacks: 1,
};

const audit = {
  provider: 'gitlab' as const,
  publication_id: 'pub1',
  pr_id: 'p1',
  outcome: 'published' as const,
  requested: 2,
  published: 2,
  failed: 0,
  general_notes: 1,
  other_drafts_published: 0,
  applicable_suggestions: 0,
  has_summary: true,
  ...deprecationFields,
};

describe('PublishPreviewWithDeprecation (AC-1, AC-19)', () => {
  it('requires the deprecation field and accepts null or a reason', () => {
    expect(PublishPreview.safeParse(preview).success).toBe(true);
    expect(PublishPreviewWithDeprecation.safeParse(preview).success).toBe(false);
    expect(PublishPreviewWithDeprecation.safeParse({ ...preview, deprecation: null }).success).toBe(
      true,
    );
    expect(
      PublishPreviewWithDeprecation.safeParse({
        ...preview,
        deprecation: { reason: 'head_unknown', reviewed_head_sha: null },
      }).success,
    ).toBe(true);
  });

  it('accepts a deferred anchor only in the widened shape', () => {
    const deferred = { ...anchor, kind: 'deferred' };
    expect(PublishAnchorWithDeprecation.safeParse(deferred).success).toBe(true);
    expect(PublishAnchor.safeParse(deferred).success).toBe(false);
    expect(
      PublishPreviewWithDeprecation.safeParse({
        ...preview,
        deprecation: { reason: 'head_moved', reviewed_head_sha: 'abc' },
        findings: [
          {
            ...preview.findings[0],
            anchor: deferred,
            published: { ...link, deprecated: true },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('widens off-diff reasons to exactly 5 values', () => {
    expect(OffDiffReasonAll.options).toEqual([
      'not_on_diff_line',
      'patch_unavailable',
      'reviewed_version_unavailable',
      'review_head_unknown',
      'position_rejected',
    ]);
    expect(
      PublishAnchorWithDeprecation.safeParse({
        ...anchor,
        kind: 'general',
        off_diff_reason: 'position_rejected',
      }).success,
    ).toBe(true);
  });
});

describe('PublishedLinkWithDeprecation (AC-24)', () => {
  it('keeps deprecated optional', () => {
    expect(PublishedLinkWithDeprecation.safeParse(link).success).toBe(true);
    expect(PublishedLinkWithDeprecation.parse({ ...link, deprecated: true }).deprecated).toBe(true);
  });
});

describe('PublishAcknowledgement (AC-4)', () => {
  it('defaults to false and rejects a non-boolean', () => {
    expect(PublishAcknowledgement.parse({}).acknowledge_deprecated).toBe(false);
    expect(
      PublishAcknowledgement.parse({ acknowledge_deprecated: true }).acknowledge_deprecated,
    ).toBe(true);
    const res = PublishAcknowledgement.safeParse({ acknowledge_deprecated: 'yes' });
    expect(res.success).toBe(false);
    expect(res.success ? [] : res.error.issues.map((i) => i.path.join('.'))).toEqual([
      'acknowledge_deprecated',
    ]);
  });
});

describe('PublishPlanQuery (AC-21)', () => {
  it('splits and trims a comma-separated uuid list', () => {
    const a = randomUUID();
    const b = randomUUID();
    expect(PublishPlanQuery.parse({ finding_ids: `${a}, ${b}` }).finding_ids).toEqual([a, b]);
  });

  it('rejects 51 ids, duplicates, a non-uuid and an empty list', () => {
    const many = Array.from({ length: 51 }, () => randomUUID()).join(',');
    const id = randomUUID();
    for (const finding_ids of [many, `${id},${id}`, `${id},not-a-uuid`, '', ' , ']) {
      const res = PublishPlanQuery.safeParse({ finding_ids });
      expect(res.success).toBe(false);
      expect(res.success ? [] : res.error.issues[0]?.path[0]).toBe('finding_ids');
    }
    expect(PublishPlanQuery.safeParse({}).success).toBe(false);
  });
});

describe('PublishPlan (AC-21)', () => {
  it('extends the other-drafts count', () => {
    expect(
      PublishPlan.safeParse({
        other_drafts: 0,
        plan_available: true,
        deprecation: { reason: 'head_moved', reviewed_head_sha: 'abc', live_head_sha: 'def' },
        placement: { positioned: 2, general: 1 },
      }).success,
    ).toBe(true);
    expect(
      PublishPlan.safeParse({ other_drafts: null, plan_available: false, placement: null }).success,
    ).toBe(true);
    expect(PublishPlan.safeParse({ other_drafts: 0, placement: null }).success).toBe(false);
  });
});

describe('PublicationWithDeprecation (AC-25)', () => {
  it('requires the 4 new fields', () => {
    expect(Publication.safeParse(publication).success).toBe(true);
    expect(PublicationWithDeprecation.safeParse(publication).success).toBe(false);
    const full = { ...publication, ...deprecationFields };
    expect(PublicationWithDeprecation.safeParse(full).success).toBe(true);
    for (const key of Object.keys(deprecationFields)) {
      const partial: Record<string, unknown> = { ...full };
      delete partial[key];
      expect(PublicationWithDeprecation.safeParse(partial).success).toBe(false);
    }
    expect(
      PublicationWithDeprecation.safeParse({
        ...full,
        deprecated: false,
        deprecation_reason: null,
        reviewed_version_found: null,
        position_fallbacks: 0,
      }).success,
    ).toBe(true);
  });
});

describe('ReviewPublishAuditMetadataWithDeprecation (AC-26)', () => {
  it('accepts the 4 new fields and stays strict', () => {
    expect(ReviewPublishAuditMetadataWithDeprecation.safeParse(audit).success).toBe(true);
    for (const key of ['head_sha', 'body', 'summary']) {
      expect(
        ReviewPublishAuditMetadataWithDeprecation.safeParse({ ...audit, [key]: 'x' }).success,
      ).toBe(false);
    }
    const missing: Record<string, unknown> = { ...audit };
    delete missing.position_fallbacks;
    expect(ReviewPublishAuditMetadataWithDeprecation.safeParse(missing).success).toBe(false);
  });
});

describe('limits', () => {
  it('caps version pages at 20', () => {
    expect(PUBLISH_VERSIONS_MAX_PAGES).toBe(20);
  });
});
