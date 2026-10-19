/**
 * Opaque token primitives: CSPRNG generation, at-rest hashing, constant-time
 * comparison, personal API tokens, session ids and PKCE (RFC 7636).
 * Pure Node built-ins; no I/O. Only hashes are meant to be persisted.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Minimum entropy for session ids and API tokens (NFR: ≥ 256 bits). */
export const MIN_TOKEN_BYTES = 32;
export const API_TOKEN_PREFIX = 'ddg_pat_';
/** Length of the displayable, non-secret token prefix stored alongside the hash. */
export const API_TOKEN_DISPLAY_PREFIX_LENGTH = 12;

/** `bytes` of CSPRNG output, base64url without padding (32 bytes → 43 chars). */
export function randomToken(bytes = MIN_TOKEN_BYTES): string {
  if (!Number.isInteger(bytes) || bytes < 1) {
    throw new RangeError('randomToken: bytes must be a positive integer');
  }
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Constant-time string equality. Both inputs are hashed first so the
 * comparison runs over equal-length digests and leaks neither content nor length.
 */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

export interface NewApiToken {
  /** Full secret value — shown to the user once, never stored. */
  value: string;
  /** First 12 chars (`ddg_pat_` + 4) — safe to store and display. */
  prefix: string;
  /** sha256 hex of `value` — what gets persisted and looked up. */
  hash: string;
}

export function newApiToken(): NewApiToken {
  const value = API_TOKEN_PREFIX + randomToken(MIN_TOKEN_BYTES);
  return {
    value,
    prefix: value.slice(0, API_TOKEN_DISPLAY_PREFIX_LENGTH),
    hash: sha256Hex(value),
  };
}

/** Opaque session id (256 bits). Persist only `sha256Hex(id)`. */
export function newSessionId(): string {
  return randomToken(MIN_TOKEN_BYTES);
}

/** PKCE code verifier: 43 chars from the unreserved alphabet (RFC 7636 §4.1). */
export function codeVerifier(): string {
  return randomToken(MIN_TOKEN_BYTES);
}

/** PKCE S256 challenge: base64url(sha256(verifier)) (RFC 7636 §4.2). */
export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}
