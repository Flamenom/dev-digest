/**
 * GitLabTokenHealthService — the scope-health gate in front of every GitLab
 * operation (spec `specs/2026-10-20-gitlab-comments.md`, AC-23, AC-24, AC-28,
 * AC-29; plan Q1/Q7).
 *
 * Application ring: depends only on two injected functions (read the stored
 * token, look up its scopes). No Fastify, Drizzle or container imports.
 *
 * State lives in process memory, keyed by a sha256 FINGERPRINT of the token
 * value — never the value itself. The fingerprint is private to this class: it
 * is never logged, persisted, returned, or put into an error. Changing the
 * token value yields a new fingerprint, so health resets to `unchecked` and is
 * re-checked once on the next use (AC-24). After a process restart every token
 * is `unchecked` again (one extra scope lookup per process — plan Q1).
 *
 * Concurrent first uses share ONE scope check (single-flight per fingerprint).
 */
import { createHash } from 'node:crypto';
import type { GitLabScopeCheck, GitLabTokenHealth } from '@devdigest/shared';
import { AppError } from '../../platform/errors.js';

/** AC-21 message — exact spec text. */
export const GITLAB_INSUFFICIENT_SCOPE_MESSAGE =
  'This token is missing the api scope. Required scope: api (Reporter role recommended).';

/** AC-28 message for a transient scope-lookup failure — exact spec text. */
export const GITLAB_UNVERIFIED_MESSAGE = "Couldn't verify the token's scopes — try again";

/** Message for a token GitLab rejected (401) during the scope check (AC-29). */
export const GITLAB_INVALID_TOKEN_MESSAGE =
  'GitLab rejected the token (invalid, expired or revoked). Update it in Settings → API keys.';

/** Auth-failure kinds the GitLab adapter reports on a live response (AC-24, AC-29). */
export type GitLabAuthFailureKind = 'invalid' | 'insufficient_scope';

export interface GitLabTokenHealthDeps {
  /** The stored GitLab token, or null when none is configured. */
  readToken: () => Promise<string | null>;
  /** Scope lookup for a token (adapter `checkTokenScopes`). */
  check: (token: string) => Promise<GitLabScopeCheck>;
}

/** A usable token and the service account it authenticates as. */
export interface UsableGitLabToken {
  token: string;
  username: string;
}

interface HealthEntry {
  health: GitLabTokenHealth;
  username: string | null;
}

/**
 * Upper bound on remembered fingerprints. Only the current token matters; old
 * ones linger only until the bound evicts them (oldest first).
 */
const MAX_ENTRIES = 16;

function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function insufficientScopeError(): AppError {
  return new AppError('gitlab_token_insufficient_scope', GITLAB_INSUFFICIENT_SCOPE_MESSAGE, 400);
}

export function unverifiedError(): AppError {
  return new AppError('gitlab_token_unverified', GITLAB_UNVERIFIED_MESSAGE, 503);
}

export function invalidTokenError(): AppError {
  return new AppError('gitlab_token_invalid', GITLAB_INVALID_TOKEN_MESSAGE, 400);
}

export class GitLabTokenHealthService {
  private readonly entries = new Map<string, HealthEntry>();
  private readonly inflight = new Map<string, Promise<GitLabScopeCheck>>();

  constructor(private readonly deps: GitLabTokenHealthDeps) {}

  /**
   * Gate a GitLab operation. Returns null when no token is configured (the
   * caller decides: anonymous public read vs `gitlab_token_missing`). Throws
   * `gitlab_token_insufficient_scope` (memoised — no further lookup, AC-23),
   * `gitlab_token_invalid`, or `gitlab_token_unverified` (health stays
   * `unchecked`, AC-28).
   */
  async ensureUsable(): Promise<UsableGitLabToken | null> {
    const token = await this.deps.readToken();
    if (!token) return null;
    const fp = fingerprint(token);
    const known = this.entries.get(fp);
    if (known?.health === 'ok' && known.username) return { token, username: known.username };
    if (known?.health === 'insufficient_scope') throw insufficientScopeError();

    // unchecked / invalid / unknown → one (shared) scope lookup (AC-24, Q7).
    const check = await this.checkOnce(fp, token);
    this.recordByFingerprint(fp, check);
    switch (check.kind) {
      case 'ok':
        return { token, username: check.username };
      case 'insufficient_scope':
        throw insufficientScopeError();
      case 'invalid':
        throw invalidTokenError();
      case 'unverified':
        throw unverifiedError();
    }
  }

  /** The stored token's health without any lookup; null when no token is configured. */
  async current(): Promise<GitLabTokenHealth | null> {
    const token = await this.deps.readToken();
    if (!token) return null;
    return this.entries.get(fingerprint(token))?.health ?? 'unchecked';
  }

  /** Record the outcome of a save/test scope lookup for `token` (AC-24 "on save"). */
  record(token: string, check: GitLabScopeCheck): void {
    this.recordByFingerprint(fingerprint(token), check);
  }

  /**
   * A live GitLab response rejected `token`. 401 → `invalid` (AC-29, shown in
   * the UI; the next use re-checks, Q7). 403 `insufficient_scope` → `unchecked`,
   * so the next use re-checks the scopes (AC-24) instead of trusting a stale `ok`.
   */
  reportAuthFailure(token: string, kind: GitLabAuthFailureKind): void {
    const fp = fingerprint(token);
    const username = this.entries.get(fp)?.username ?? null;
    this.set(fp, { health: kind === 'invalid' ? 'invalid' : 'unchecked', username });
  }

  private checkOnce(fp: string, token: string): Promise<GitLabScopeCheck> {
    const pending = this.inflight.get(fp);
    if (pending) return pending;
    const run = this.deps
      .check(token)
      // An unexpected throw from the lookup is treated as transient (AC-28):
      // the token stays `unchecked` and the next use retries.
      .catch((): GitLabScopeCheck => ({ kind: 'unverified' }))
      .finally(() => this.inflight.delete(fp));
    this.inflight.set(fp, run);
    return run;
  }

  private recordByFingerprint(fp: string, check: GitLabScopeCheck): void {
    switch (check.kind) {
      case 'ok':
        this.set(fp, { health: 'ok', username: check.username });
        return;
      case 'insufficient_scope':
        this.set(fp, { health: 'insufficient_scope', username: check.username });
        return;
      case 'invalid':
        this.set(fp, { health: 'invalid', username: null });
        return;
      case 'unverified':
        // Transient: never lock out. Keep whatever is known; default `unchecked`.
        if (!this.entries.has(fp)) this.set(fp, { health: 'unchecked', username: null });
        return;
    }
  }

  private set(fp: string, entry: HealthEntry): void {
    this.entries.delete(fp);
    this.entries.set(fp, entry);
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
