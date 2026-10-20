/**
 * Host-comments contracts (GitLab comments spec, plan T1): the new schemas are
 * additive over the existing comment shapes, reject blank bodies and ambiguous
 * reply targets, and the audit metadata can never carry the comment body.
 */
import { describe, it, expect } from 'vitest';
import {
  ConnTestResultWithCode,
  GITLAB_COMMENT_MAX_CHARS,
  GitLabTokenHealth,
  HostComment,
  HostCommentErrorCode,
  HostCommentInput,
  PrCommentAuditMetadata,
  PrCommentInput,
  PrReviewComment,
} from '@devdigest/shared';

const githubComment = {
  id: 101,
  path: 'src/a.ts',
  line: 12,
  original_line: 12,
  side: 'RIGHT' as const,
  body: 'Looks off',
  user: 'octocat',
  created_at: '2026-10-20T10:00:00Z',
  html_url: 'https://github.com/acme/web/pull/1#discussion_r101',
  in_reply_to_id: null,
  is_outdated: false,
};

describe('HostComment', () => {
  it('parses an existing PrReviewComment fixture unchanged (AC-34 additive)', () => {
    expect(PrReviewComment.parse(githubComment)).toEqual(githubComment);
    const parsed = HostComment.parse(githubComment);
    expect(parsed).toEqual(githubComment);
  });

  it('accepts the GitLab extras (discussion id, provider, attribution)', () => {
    const parsed = HostComment.parse({
      ...githubComment,
      in_reply_to_id: 100,
      discussion_id: 'abc123',
      provider: 'gitlab',
      devdigest_attribution: { name: 'Ada' },
    });
    expect(parsed.discussion_id).toBe('abc123');
    expect(parsed.devdigest_attribution).toEqual({ name: 'Ada' });
    expect(HostComment.safeParse({ ...githubComment, provider: 'bitbucket' }).success).toBe(false);
  });
});

describe('HostCommentInput', () => {
  const base = { path: 'src/a.ts', line: 3, side: 'RIGHT' as const, body: 'Nit' };

  it('accepts what PrCommentInput accepts, plus a GitLab discussion_id', () => {
    expect(PrCommentInput.safeParse(base).success).toBe(true);
    expect(HostCommentInput.safeParse(base).success).toBe(true);
    expect(HostCommentInput.safeParse({ ...base, in_reply_to: 7 }).success).toBe(true);
    expect(HostCommentInput.safeParse({ ...base, discussion_id: 'd1' }).success).toBe(true);
  });

  it('rejects an empty or whitespace-only body (AC-14)', () => {
    for (const body of ['', '   ', '\n\t ']) {
      const r = HostCommentInput.safeParse({ ...base, body });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues.some((i) => i.path[0] === 'body')).toBe(true);
    }
  });

  it('rejects in_reply_to and discussion_id together', () => {
    const r = HostCommentInput.safeParse({ ...base, in_reply_to: 7, discussion_id: 'd1' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['discussion_id']);
  });

  it('rejects an empty discussion_id', () => {
    expect(HostCommentInput.safeParse({ ...base, discussion_id: '' }).success).toBe(false);
  });
});

describe('PrCommentAuditMetadata', () => {
  const meta = { provider: 'gitlab' as const, host_comment_id: 55, discussion_id: 'd1', is_reply: true };

  it('accepts the documented metadata', () => {
    expect(PrCommentAuditMetadata.parse(meta)).toEqual(meta);
    expect(
      PrCommentAuditMetadata.safeParse({ provider: 'github', host_comment_id: 1, is_reply: false }).success,
    ).toBe(true);
  });

  it('rejects a body key (AC-42: the body is never recorded)', () => {
    expect(PrCommentAuditMetadata.safeParse({ ...meta, body: 'secret text' }).success).toBe(false);
  });
});

describe('enums and constants', () => {
  it('GitLabTokenHealth has exactly the 4 spec values', () => {
    expect(GitLabTokenHealth.options).toEqual(['ok', 'insufficient_scope', 'invalid', 'unchecked']);
  });

  it('HostCommentErrorCode lists the new error codes', () => {
    expect(HostCommentErrorCode.options).toEqual([
      'comment_position_invalid',
      'comment_diff_outdated',
      'comment_thread_not_found',
      'comment_too_long',
      'gitlab_token_insufficient_scope',
      'gitlab_token_unverified',
      'gitlab_comment_failed',
    ]);
  });

  it('GITLAB_COMMENT_MAX_CHARS is 1,000,000', () => {
    expect(GITLAB_COMMENT_MAX_CHARS).toBe(1_000_000);
  });

  it('ConnTestResultWithCode keeps old results valid and adds an optional code', () => {
    const ok = { provider: 'gitlab', ok: true, message: 'Connected as @ada' };
    expect(ConnTestResultWithCode.safeParse(ok).success).toBe(true);
    expect(
      ConnTestResultWithCode.parse({ ...ok, ok: false, code: 'gitlab_token_insufficient_scope' }).code,
    ).toBe('gitlab_token_insufficient_scope');
  });
});
