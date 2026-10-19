/**
 * Identity route helpers (spec SPEC-2026-10-19-multi-user-server; plan T22).
 * Pure: DTO projections, the avatar-URL allowlist and cookie attribute sets.
 * No Fastify, no container, no I/O — `routes.ts` applies them.
 */
import type { CurrentSession, Member, MemberList, Role } from '@devdigest/shared';
import {
  OAUTH_BINDING_COOKIE,
  OAUTH_FLOW_TTL_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE,
} from './constants.js';

// ---- avatar (untrusted ID-token claim) ---------------------------------------

const AVATAR_HOST_SUFFIX = '.googleusercontent.com';
const MAX_AVATAR_URL_LENGTH = 2048;

/**
 * The avatar URL if it is an `https` URL on Google's image host
 * (`*.googleusercontent.com`, default port, no userinfo); otherwise null so the
 * client shows a default avatar ("Untrusted inputs" — `picture`).
 */
export function safeAvatarUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_AVATAR_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '' || url.port !== '') return null;
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(AVATAR_HOST_SUFFIX) || host.length === AVATAR_HOST_SUFFIX.length) return null;
  return url.toString();
}

// ---- DTOs --------------------------------------------------------------------

export interface SessionUserInput {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

/** `GET /auth/session` body (`CurrentSession`). */
export function toCurrentSession(input: {
  mode: CurrentSession['mode'];
  user: SessionUserInput;
  role: Role;
  workspace: { id: string; name: string };
  allowedDomain?: string | null;
}): CurrentSession {
  return {
    mode: input.mode,
    user: {
      id: input.user.id,
      email: input.user.email,
      name: input.user.name,
      avatar_url: safeAvatarUrl(input.user.avatarUrl),
      role: input.role,
    },
    workspace: { id: input.workspace.id, name: input.workspace.name },
    ...(input.allowedDomain ? { allowed_domain: input.allowedDomain } : {}),
  };
}

/** A member DTO with its avatar passed through the allowlist. */
export function memberToDto(m: Member): Member {
  return { ...m, avatar_url: safeAvatarUrl(m.avatar_url) };
}

export function memberListToDto(list: MemberList): MemberList {
  return { members: list.members.map(memberToDto), has_active_admin: list.has_active_admin };
}

// ---- query values -------------------------------------------------------------

/** A single query value as a string; repeated (array) or absent values → undefined. */
export function queryString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// ---- redirects ----------------------------------------------------------------

/** `${origin}${returnTo}` — `returnTo` is already a validated same-origin path (AC-16). */
export function postSignInLocation(publicOrigin: string, returnTo: string): string {
  return `${publicOrigin}${returnTo}`;
}

/** The sign-in screen with a stable auth error code (never Google's raw text). */
export function signInErrorLocation(publicOrigin: string, code: string): string {
  return `${publicOrigin}/sign-in?error=${encodeURIComponent(code)}`;
}

// ---- cookies (AC-7, AC-24) ------------------------------------------------------

/** Framework-neutral cookie attributes (structurally what `@fastify/cookie` accepts). */
export interface CookieAttributes {
  httpOnly: true;
  secure: true;
  sameSite: 'lax';
  path: '/';
  /** Seconds. 0 + `expires` in the past clears the cookie. */
  maxAge: number;
  expires?: Date;
}

/**
 * `__Host-` cookies: Secure, Path=/, no Domain (host-only). `SameSite=Lax`, not
 * Strict — Strict is not sent on the top-level redirect back from Google.
 */
function hostCookie(maxAgeMs: number): CookieAttributes {
  return { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: Math.floor(maxAgeMs / 1000) };
}

const CLEARED: CookieAttributes = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
  maxAge: 0,
  expires: new Date(0),
};

export const sessionCookie = {
  name: SESSION_COOKIE,
  /** Lives as long as the absolute session lifetime; the server enforces idle expiry. */
  set: (): CookieAttributes => hostCookie(SESSION_ABSOLUTE_MS),
  clear: (): CookieAttributes => ({ ...CLEARED }),
} as const;

export const oauthBindingCookie = {
  name: OAUTH_BINDING_COOKIE,
  set: (): CookieAttributes => hostCookie(OAUTH_FLOW_TTL_MS),
  clear: (): CookieAttributes => ({ ...CLEARED }),
} as const;
