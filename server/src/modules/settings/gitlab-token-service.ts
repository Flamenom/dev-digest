/**
 * GitLabTokenService — save / test of the workspace GitLab token (spec
 * `specs/2026-10-20-gitlab-comments.md`, AC-21, AC-22, AC-24, AC-28, AC-29).
 *
 * The candidate token's scopes are probed BEFORE anything is stored: a token
 * without `api`, one GitLab rejects, or one whose scopes can't be determined is
 * never saved, so the previous token stays in place (AC-21, AC-28).
 *
 * Saving goes through the injected `saveToken`. The composition root wires it
 * to `SettingsService.saveSecret`, which writes the `secret.save` audit row
 * inside the write's own transaction — so a rejected key leaves no audit row
 * (PR #14 pattern; plan Rec1/Rec2).
 *
 * Application ring: no Fastify, Drizzle or container imports. Result messages
 * never contain the key (they are fixed strings plus the GitLab username).
 */
import type { ConnTestResultWithCode, GitLabScopeCheck } from '@devdigest/shared';
import {
  GITLAB_INSUFFICIENT_SCOPE_MESSAGE,
  GITLAB_UNVERIFIED_MESSAGE,
  type GitLabTokenHealthService,
} from './gitlab-token-health.js';

/** The outcome without the `provider` field (the route adds it). */
export type GitLabTokenTestResult = Omit<ConnTestResultWithCode, 'provider'>;

export interface GitLabTokenServiceDeps<Actor> {
  /** Scope lookup for a candidate token (a token-specific adapter's `checkTokenScopes`). */
  probe: (token: string) => Promise<GitLabScopeCheck>;
  /** The stored GitLab token, or null. */
  readToken: () => Promise<string | null>;
  /** Persist the token as `GITLAB_TOKEN` (+ its `secret.save` audit row) on behalf of `actor`. */
  saveToken: (token: string, actor: Actor) => Promise<void>;
  /** Drop cached host clients so the next use picks up the new token. */
  invalidateCaches: () => void;
  health: Pick<GitLabTokenHealthService, 'record'>;
}

const NO_TOKEN_RESULT: GitLabTokenTestResult = {
  ok: false,
  code: 'gitlab_token_missing',
  message: 'No GitLab token is configured.',
};

/** Translate a failed scope lookup into the connection-test result (never echoes the key). */
function failureResult(check: Exclude<GitLabScopeCheck, { kind: 'ok' }>): GitLabTokenTestResult {
  switch (check.kind) {
    case 'insufficient_scope':
      return { ok: false, code: 'gitlab_token_insufficient_scope', message: GITLAB_INSUFFICIENT_SCOPE_MESSAGE };
    case 'unverified':
      return { ok: false, code: 'gitlab_token_unverified', message: GITLAB_UNVERIFIED_MESSAGE };
    case 'invalid':
      return { ok: false, code: 'gitlab_token_invalid', message: `GitLab token is ${check.reason}` };
  }
}

function connected(username: string): GitLabTokenTestResult {
  return { ok: true, message: `Connected as @${username}` };
}

export class GitLabTokenService<Actor> {
  constructor(private readonly deps: GitLabTokenServiceDeps<Actor>) {}

  /**
   * Save a new token: probe first, store only on `ok` (AC-21, AC-22, AC-28).
   * A save failure propagates (the route turns it into its error/`ok:false`
   * envelope); nothing is recorded as healthy in that case.
   */
  async save(key: string, actor: Actor): Promise<GitLabTokenTestResult> {
    const check = await this.deps.probe(key);
    if (check.kind !== 'ok') return failureResult(check);
    await this.deps.saveToken(key, actor);
    this.deps.invalidateCaches();
    this.deps.health.record(key, check);
    return connected(check.username);
  }

  /**
   * Test the stored token (no key supplied). The outcome is remembered as the
   * stored token's health (AC-24), except a transient `unverified`, which
   * leaves it `unchecked` (AC-28).
   */
  async testStored(): Promise<GitLabTokenTestResult> {
    const token = await this.deps.readToken();
    if (!token) return NO_TOKEN_RESULT;
    const check = await this.deps.probe(token);
    this.deps.health.record(token, check);
    return check.kind === 'ok' ? connected(check.username) : failureResult(check);
  }
}
