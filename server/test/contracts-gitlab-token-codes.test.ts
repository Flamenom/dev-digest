/**
 * Task H5 — `ConnTestResultWithCode.code` is narrowed to an enum by an ADDITIVE
 * contract (`contracts/gitlab-token-codes.ts`). Every code the GitLab token
 * service can emit must be in the enum, and an unknown code must be rejected.
 */
import { describe, it, expect } from 'vitest';
import {
  ConnTestResultWithCode,
  ConnTestResultWithTypedCode,
  GitLabTokenTestCode,
  type GitLabScopeCheck,
} from '@devdigest/shared';
import { GitLabTokenHealthService } from '../src/modules/settings/gitlab-token-health.js';
import { GitLabTokenService } from '../src/modules/settings/gitlab-token-service.js';

const ok = { provider: 'gitlab', ok: true, message: 'Connected as @ada' };

function service(check: GitLabScopeCheck, stored: string | null) {
  const probe = async () => check;
  return new GitLabTokenService<null>({
    probe,
    readToken: async () => stored,
    saveToken: async () => {},
    invalidateCaches: () => {},
    health: new GitLabTokenHealthService({ readToken: async () => stored, check: probe }),
  });
}

describe('GitLabTokenTestCode / ConnTestResultWithTypedCode', () => {
  it('has exactly the four codes the settings test-connection emits', () => {
    expect(GitLabTokenTestCode.options).toEqual([
      'gitlab_token_missing',
      'gitlab_token_insufficient_scope',
      'gitlab_token_unverified',
      'gitlab_token_invalid',
    ]);
  });

  it('keeps code-less results valid, accepts a known code and rejects a free string', () => {
    expect(ConnTestResultWithTypedCode.safeParse(ok).success).toBe(true);
    expect(
      ConnTestResultWithTypedCode.parse({ ...ok, ok: false, code: 'gitlab_token_invalid' }).code,
    ).toBe('gitlab_token_invalid');
    const free = { ...ok, ok: false, code: 'something_else' };
    expect(ConnTestResultWithCode.safeParse(free).success).toBe(true); // the old contract is unchanged
    expect(ConnTestResultWithTypedCode.safeParse(free).success).toBe(false);
  });

  it('every GitLabTokenService outcome parses with the typed schema', async () => {
    const results = [
      await service({ kind: 'ok', username: 'bot', scopes: ['api'] }, null).testStored(), // no token → missing
      await service({ kind: 'insufficient_scope', username: 'bot' }, 't').testStored(),
      await service({ kind: 'unverified' }, 't').testStored(),
      await service({ kind: 'invalid', reason: 'revoked' }, 't').testStored(),
      await service({ kind: 'ok', username: 'bot', scopes: ['api'] }, 't').save('glpat-new', null),
    ];
    const codes = results.map((r) => ConnTestResultWithTypedCode.parse({ provider: 'gitlab', ...r }).code);
    expect(codes).toEqual([
      'gitlab_token_missing',
      'gitlab_token_insufficient_scope',
      'gitlab_token_unverified',
      'gitlab_token_invalid',
      undefined,
    ]);
  });
});
