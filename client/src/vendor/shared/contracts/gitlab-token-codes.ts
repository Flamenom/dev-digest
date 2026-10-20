import { z } from 'zod';
import { ConnTestResultWithCode } from './host-comments.js';

/**
 * Typed failure codes of the GitLab token connection test / save
 * (POST /settings/test-connection with provider `gitlab`; spec
 * `specs/2026-10-20-gitlab-comments.md`, AC-21, AC-28).
 *
 * ADDITIVE contract — `ConnTestResultWithCode` (host-comments.ts) keeps its free
 * `code: string`; this file narrows it without editing the existing file.
 */
export const GitLabTokenTestCode = z.enum([
  /** No GitLab token is stored (test of the stored token). */
  'gitlab_token_missing',
  /** The token lacks the `api` scope. */
  'gitlab_token_insufficient_scope',
  /** GitLab could not confirm the token's scopes (transient / unreachable). */
  'gitlab_token_unverified',
  /** GitLab rejected the token (revoked, expired, unknown). */
  'gitlab_token_invalid',
]);
export type GitLabTokenTestCode = z.infer<typeof GitLabTokenTestCode>;

/** Connection test / save result whose failure `code` is one of `GitLabTokenTestCode`. */
export const ConnTestResultWithTypedCode = ConnTestResultWithCode.extend({
  code: GitLabTokenTestCode.optional(),
});
export type ConnTestResultWithTypedCode = z.infer<typeof ConnTestResultWithTypedCode>;
