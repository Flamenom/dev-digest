/**
 * Identity module constants (spec SPEC-2026-10-19-multi-user-server).
 * Pure values — no imports, safe for every ring of the module.
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A session ends after this long without activity (AC-25). */
export const SESSION_IDLE_MS = 24 * HOUR_MS;
/** A session ends this long after issue, regardless of activity (AC-25). */
export const SESSION_ABSOLUTE_MS = 30 * DAY_MS;
/** An OIDC `state`/`nonce` pair expires this long after issue (AC-7). */
export const OAUTH_FLOW_TTL_MS = 10 * MINUTE_MS;
/** `last_seen_at` / `last_used_at` are written at most once per this window. */
export const TOUCH_THROTTLE_MS = 60 * SECOND_MS;

/**
 * Max expired rows (per table) one sweep deletes — bounds the DELETE that
 * piggybacks on `oauthFlows.create` / `sessions.create` and the periodic sweep.
 */
export const EXPIRED_SWEEP_BATCH = 500;
/** google mode: period of the background expired-flow / expired-session sweep. */
export const IDENTITY_SWEEP_INTERVAL_MS = 10 * MINUTE_MS;

/** Max active (unrevoked, unexpired) personal API tokens per user (AC-58). */
export const TOKEN_LIMIT = 10;
/** Default personal-token lifetime in days (mirrors the contract default). */
export const TOKEN_DEFAULT_DAYS = 90;

/** Session cookie — `__Host-` ⇒ Secure, Path=/, no Domain (AC-24). */
export const SESSION_COOKIE = '__Host-ddg_session';
/** Browser-binding cookie for an in-flight OIDC flow (AC-7). */
export const OAUTH_BINDING_COOKIE = '__Host-ddg_oauth';
