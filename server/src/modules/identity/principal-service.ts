/**
 * PrincipalService — resolves WHO is calling, on every request (google mode).
 * Implements the `PrincipalProvider` port (spec SPEC-2026-10-19-multi-user-server).
 *
 * - `Authorization: Bearer ddg_pat_…` wins over the session cookie (AC-56);
 *   a request that presents a bearer token is judged by that token alone.
 * - Role and membership status come from the database on EVERY call — the
 *   repository joins the current membership (AC-27); nothing is cached here.
 * - Sessions end 24 h after the last activity or 30 d after issue (AC-25),
 *   checked against the injected `Clock`. The repository filters too; the
 *   service re-checks so the policy does not depend on one SQL predicate.
 * - `last_seen_at` / `last_used_at` are written at most once per
 *   `TOUCH_THROTTLE_MS`.
 * - Fail closed: "not authenticated" is `null`; every other failure (DB down,
 *   a throwing touch) PROPAGATES — never an anonymous or default principal.
 *
 * Only hashes reach the repository; raw cookie / token values never leave
 * this function and are never logged.
 */
import type { AuthRequestLike, Clock, Principal, PrincipalProvider } from '@devdigest/shared';
import { API_TOKEN_PREFIX, sha256Hex } from '../../platform/crypto/tokens.js';
import { SESSION_COOKIE, SESSION_IDLE_MS, TOUCH_THROTTLE_MS } from './constants.js';
import type { IdentityRepository } from './repository.js';

/** Longer values are rejected before hashing (no legitimate value comes close). */
const MAX_CREDENTIAL_LENGTH = 512;
const BEARER_RE = /^Bearer[ \t]+(\S+)[ \t]*$/i;

/** The slice of {@link IdentityRepository} the resolver needs (fakes implement just this). */
export interface PrincipalRepository {
  sessions: Pick<IdentityRepository['sessions'], 'findActiveByHash' | 'touch'>;
  apiTokens: Pick<IdentityRepository['apiTokens'], 'findActiveByHash' | 'touch'>;
}

export interface PrincipalServiceDeps {
  repo: PrincipalRepository;
  clock: Clock;
}

/** A single header value; repeated (array) headers are ambiguous and ignored. */
function headerOf(req: AuthRequestLike, name: string): string | undefined {
  const raw = req.headers[name];
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * The bearer credential, or:
 *  - `undefined` when the request carries no `Bearer` authorization at all;
 *  - `null` when it carries one that is malformed / repeated (→ unauthenticated).
 */
function bearerOf(req: AuthRequestLike): string | null | undefined {
  const raw = req.headers.authorization;
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    return raw.some((v) => /^bearer\b/i.test(v.trim())) ? null : undefined;
  }
  if (!/^bearer\b/i.test(raw.trim())) return undefined; // another scheme — not ours
  const match = BEARER_RE.exec(raw.trim());
  if (!match) return null;
  const token = match[1]!;
  if (!token.startsWith(API_TOKEN_PREFIX) || token.length > MAX_CREDENTIAL_LENGTH) return null;
  return token;
}

/**
 * The session cookie value from a raw `Cookie` header, or undefined. The
 * value is used verbatim (it is base64url) — no decoding that could throw.
 * Exported for the sign-out route, which needs the same value to delete.
 */
export function sessionCookieValue(req: AuthRequestLike): string | undefined {
  const header = headerOf(req, 'cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (value.length === 0 || value.length > MAX_CREDENTIAL_LENGTH) return undefined;
    return value;
  }
  return undefined;
}

function shouldTouch(last: Date | null, now: Date): boolean {
  return last === null || now.getTime() - last.getTime() >= TOUCH_THROTTLE_MS;
}

export class PrincipalService implements PrincipalProvider {
  constructor(private readonly deps: PrincipalServiceDeps) {}

  readonly resolve = async (req: AuthRequestLike): Promise<Principal | null> => {
    const bearer = bearerOf(req);
    if (bearer === null) return null;
    if (bearer !== undefined) return this.fromToken(bearer);
    const session = sessionCookieValue(req);
    return session === undefined ? null : this.fromSession(session);
  };

  private async fromSession(value: string): Promise<Principal | null> {
    const now = this.deps.clock.now();
    const session = await this.deps.repo.sessions.findActiveByHash(sha256Hex(value), now);
    if (!session) return null;
    const t = now.getTime();
    // Defense in depth over the repository predicate (AC-25).
    if (session.expiresAt.getTime() <= t) return null;
    if (t - session.lastSeenAt.getTime() >= SESSION_IDLE_MS) return null;
    if (shouldTouch(session.lastSeenAt, now)) {
      await this.deps.repo.sessions.touch(session.sessionId, now);
    }
    return {
      userId: session.userId,
      workspaceId: session.workspaceId,
      role: session.role,
      via: 'session',
      sessionId: session.sessionId,
    };
  }

  private async fromToken(value: string): Promise<Principal | null> {
    const now = this.deps.clock.now();
    const token = await this.deps.repo.apiTokens.findActiveByHash(sha256Hex(value), now);
    if (!token) return null;
    if (shouldTouch(token.lastUsedAt, now)) {
      await this.deps.repo.apiTokens.touch(token.tokenId, now);
    }
    return {
      userId: token.userId,
      workspaceId: token.workspaceId,
      role: token.role,
      via: 'token',
      tokenId: token.tokenId,
    };
  }
}
