/**
 * Publish codes, fixed messages and status table (spec "Contracts"; AC-4, AC-5,
 * AC-31, AC-33; plan Q4/Q5).
 */
import { describe, it, expect } from 'vitest';
import { PublishBlockerCode, PublishErrorCode, type GitLabWriteFailure } from '@devdigest/shared';
import {
  DEPRECATED_NOT_ACKNOWLEDGED_MESSAGE,
  PUBLISH_HTTP_STATUS,
  PUBLISH_MESSAGES,
  blockerMessage,
  failureToPublicationCode,
  publishError,
} from '../src/modules/publish/codes.js';
import {
  GITLAB_INSUFFICIENT_SCOPE_MESSAGE,
  GITLAB_INVALID_TOKEN_MESSAGE,
  GITLAB_UNVERIFIED_MESSAGE,
} from '../src/modules/settings/gitlab-token-health.js';

describe('publish messages', () => {
  it('AC-33 message and the outdated-findings AC-4 message equal the spec strings byte-for-byte', () => {
    const ac4 = 'This review is outdated — confirm publishing its findings as deprecated.';
    expect(DEPRECATED_NOT_ACKNOWLEDGED_MESSAGE).toBe(ac4);
    expect(PUBLISH_MESSAGES.review_diff_outdated).toBe(ac4);
    expect(PUBLISH_MESSAGES.review_head_unknown).toBe(ac4);
    expect(blockerMessage('review_head_unknown')).toBe(ac4);
    expect(blockerMessage('review_diff_outdated')).toBe(ac4);
    expect(PUBLISH_HTTP_STATUS.review_head_unknown).toBe(409);
    expect(PUBLISH_HTTP_STATUS.review_diff_outdated).toBe(409);
    expect(PUBLISH_MESSAGES.gitlab_publish_unconfirmed).toBe(
      "GitLab didn't confirm the publish — check the MR before publishing again.",
    );
  });

  it('AC-31 message says the drafts remain on the service account', () => {
    expect(PUBLISH_MESSAGES.gitlab_drafts_left_behind).toMatch(/remain on the service account/);
  });

  it('reused token messages equal the comments-spec constants', () => {
    expect(PUBLISH_MESSAGES.gitlab_token_insufficient_scope).toBe(GITLAB_INSUFFICIENT_SCOPE_MESSAGE);
    expect(PUBLISH_MESSAGES.gitlab_token_invalid).toBe(GITLAB_INVALID_TOKEN_MESSAGE);
    expect(PUBLISH_MESSAGES.gitlab_token_unverified).toBe(GITLAB_UNVERIFIED_MESSAGE);
  });

  it('every code and every blocker has a non-empty message and a status', () => {
    for (const code of PublishErrorCode.options) {
      expect(PUBLISH_MESSAGES[code].length).toBeGreaterThan(0);
      expect(PUBLISH_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
    for (const code of PublishBlockerCode.options) expect(blockerMessage(code).length).toBeGreaterThan(0);
    expect(Object.keys(PUBLISH_MESSAGES).sort()).toEqual([...PublishErrorCode.options].sort());
  });
});

describe('PUBLISH_HTTP_STATUS (spec Contracts table)', () => {
  it.each([
    ['publish_selection_invalid', 400],
    ['publish_summary_invalid', 400],
    ['finding_not_publishable', 400],
    ['finding_already_published', 409],
    ['publish_in_progress', 409],
    ['provider_not_supported', 400],
    ['review_head_unknown', 409],
    ['review_diff_outdated', 409],
    ['pr_not_open', 409],
    ['gitlab_token_missing', 400],
    ['gitlab_token_invalid', 400],
    ['gitlab_token_insufficient_scope', 400],
    ['gitlab_project_inaccessible', 404],
  ] as const)('%s → %i', (code, status) => {
    expect(PUBLISH_HTTP_STATUS[code]).toBe(status);
    const err = publishError(code, { finding_ids: ['x'] });
    expect(err.code).toBe(code);
    expect(err.statusCode).toBe(status);
    expect(err.message).toBe(PUBLISH_MESSAGES[code]);
    expect(err.details).toEqual({ finding_ids: ['x'] });
  });
});

describe('failureToPublicationCode (plan Q4/Q5)', () => {
  it.each([
    [{ kind: 'rejected', status: 422 }, 'gitlab_position_rejected'],
    [{ kind: 'rejected', status: 400 }, 'gitlab_position_rejected'],
    [{ kind: 'rate_limited' }, 'gitlab_rate_limited'],
    [{ kind: 'token_invalid' }, 'gitlab_token_invalid'],
    [{ kind: 'insufficient_scope' }, 'gitlab_token_insufficient_scope'],
    [{ kind: 'forbidden' }, 'gitlab_publish_failed'],
    [{ kind: 'not_found' }, 'gitlab_project_inaccessible'],
    [{ kind: 'unconfirmed' }, 'gitlab_publish_failed'],
  ] as const)('%o → %s', (failure, code) => {
    expect(failureToPublicationCode(failure as GitLabWriteFailure)).toBe(code);
  });
});
