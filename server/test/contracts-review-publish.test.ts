/**
 * T1 — publish-findings contracts (spec `specs/2026-10-21-gitlab-publish-findings.md`).
 * Additive review shape (AC-1), request validation paths (AC-20), strict audit
 * metadata (AC-41), the spec enums, and the https-only published link.
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  FindingUnpublishableReason,
  PublishBlockerCode,
  PublishErrorCode,
  PublishRequest,
  PublishedLink,
  ReviewPublishAuditMetadata,
  ReviewRecordWithActor,
  ReviewRecordWithHead,
} from '@devdigest/shared';

const review = {
  id: 'r1',
  pr_id: 'p1',
  agent_id: null,
  run_id: null,
  kind: 'review' as const,
  verdict: null,
  summary: null,
  score: null,
  model: null,
  created_at: '2026-10-21T00:00:00.000Z',
  findings: [],
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
};

const link = {
  discussion_id: 'd1',
  note_id: 7,
  url: 'https://gitlab.com/g/p/-/merge_requests/1#note_7',
  published_at: '2026-10-21T00:00:00.000Z',
  published_by: { id: 'u1', name: 'Ada' },
  publication_id: 'pub1',
};

function issuePaths(input: unknown): string[] {
  const res = PublishRequest.safeParse(input);
  expect(res.success).toBe(false);
  return res.success ? [] : res.error.issues.map((i) => i.path.join('.'));
}

describe('ReviewRecordWithHead (AC-1)', () => {
  it('parses an existing ReviewRecordWithActor payload without head_sha', () => {
    expect(ReviewRecordWithActor.safeParse(review).success).toBe(true);
    const res = ReviewRecordWithHead.safeParse(review);
    expect(res.success).toBe(true);
    expect(ReviewRecordWithHead.parse({ ...review, head_sha: null }).head_sha).toBeNull();
    expect(ReviewRecordWithHead.parse({ ...review, head_sha: 'abc' }).head_sha).toBe('abc');
  });
});

describe('PublishRequest (AC-20)', () => {
  it('reports invalid selections at finding_ids', () => {
    const many = Array.from({ length: 51 }, () => randomUUID());
    expect(issuePaths({ finding_ids: many })).toContain('finding_ids');
    const id = randomUUID();
    expect(issuePaths({ finding_ids: [id, id] })).toContain('finding_ids');
    expect(issuePaths({ finding_ids: [] })).toContain('finding_ids');
  });

  it('reports invalid summaries at summary', () => {
    const ids = [randomUUID()];
    expect(issuePaths({ finding_ids: ids, summary: '   ' })).toEqual(['summary']);
    expect(issuePaths({ finding_ids: ids, summary: 'x'.repeat(10_001) })).toEqual(['summary']);
    expect(PublishRequest.safeParse({ finding_ids: ids, summary: 'x'.repeat(10_000) }).success).toBe(
      true,
    );
  });

  it('defaults apply_suggestions to false', () => {
    const parsed = PublishRequest.parse({ finding_ids: [randomUUID()] });
    expect(parsed.apply_suggestions).toBe(false);
    expect(parsed.summary).toBeUndefined();
  });
});

describe('ReviewPublishAuditMetadata (AC-41)', () => {
  it('accepts counts only and rejects body-like keys', () => {
    expect(ReviewPublishAuditMetadata.safeParse(audit).success).toBe(true);
    for (const key of ['summary', 'body', 'note_id']) {
      expect(ReviewPublishAuditMetadata.safeParse({ ...audit, [key]: 'x' }).success).toBe(false);
    }
    expect(ReviewPublishAuditMetadata.safeParse({ ...audit, outcome: 'in_progress' }).success).toBe(
      false,
    );
  });
});

describe('enums', () => {
  it('match the spec values', () => {
    expect(PublishBlockerCode.options).toEqual([
      'provider_not_supported',
      'review_head_unknown',
      'review_diff_outdated',
      'publish_in_progress',
      'pr_not_open',
      'gitlab_token_missing',
      'gitlab_token_insufficient_scope',
      'gitlab_token_invalid',
    ]);
    expect(FindingUnpublishableReason.options).toEqual([
      'body_too_long',
      'dismissed',
      'already_published',
      'publish_unconfirmed',
    ]);
    expect(PublishErrorCode.options).toHaveLength(19);
  });
});

describe('PublishedLink', () => {
  it('accepts https and null urls, rejects http', () => {
    expect(PublishedLink.safeParse(link).success).toBe(true);
    expect(PublishedLink.safeParse({ ...link, url: null }).success).toBe(true);
    expect(
      PublishedLink.safeParse({ ...link, url: 'http://gitlab.com/g/p/-/merge_requests/1' }).success,
    ).toBe(false);
  });
});
