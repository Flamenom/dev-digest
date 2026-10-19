import { z } from 'zod';

/**
 * Multi-user server mode — auth, members and personal-token contracts
 * (spec SPEC-2026-10-19-multi-user-server, "Contracts"). ADDITIVE: no existing
 * contract is edited; `AuthProvider` / `ApiErrorBody` stay as they are and the
 * error codes below are stable strings carried in the existing error envelope.
 */

// ---- Modes, roles, membership status ----
export const AuthMode = z.enum(['local', 'google']);
export type AuthMode = z.infer<typeof AuthMode>;

/** Membership role. The legacy persisted value `owner` maps to `admin` (AC-48). */
export const Role = z.enum(['admin', 'member']);
export type Role = z.infer<typeof Role>;

export const MemberStatus = z.enum(['active', 'deactivated']);
export type MemberStatus = z.infer<typeof MemberStatus>;

// ---- Session probe (GET /auth/session; 401 when signed out in google mode) ----
export const CurrentSessionUser = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  avatar_url: z.string().nullable(),
  role: Role,
});
export type CurrentSessionUser = z.infer<typeof CurrentSessionUser>;

export const CurrentSessionWorkspace = z.object({
  id: z.string(),
  name: z.string(),
});
export type CurrentSessionWorkspace = z.infer<typeof CurrentSessionWorkspace>;

export const CurrentSession = z.object({
  mode: AuthMode,
  user: CurrentSessionUser,
  workspace: CurrentSessionWorkspace,
  /** Google mode only — the admitted email domain (e.g. `onlytraf.com`). */
  allowed_domain: z.string().optional(),
});
export type CurrentSession = z.infer<typeof CurrentSession>;

/** Response of POST /auth/sign-out (the cookie is cleared alongside). */
export const SignOutResult = z.object({ ok: z.literal(true) });
export type SignOutResult = z.infer<typeof SignOutResult>;

// ---- Members ----
export const Member = z.object({
  user_id: z.string(),
  email: z.string(),
  name: z.string(),
  avatar_url: z.string().nullable(),
  role: Role,
  status: MemberStatus,
  /** ISO timestamp; falls back to the user's creation time for legacy rows (Q11). */
  joined_at: z.string(),
  last_sign_in_at: z.string().nullable(),
});
export type Member = z.infer<typeof Member>;

export const MemberList = z.object({
  members: z.array(Member),
  has_active_admin: z.boolean(),
});
export type MemberList = z.infer<typeof MemberList>;

/**
 * PATCH /members/:userId body (Admin, session only). Unknown keys are stripped
 * (no mass assignment); at least one known field must remain.
 */
export const MemberUpdate = z
  .object({
    role: Role.optional(),
    status: MemberStatus.optional(),
  })
  .refine((v) => v.role !== undefined || v.status !== undefined, {
    message: 'At least one of role or status is required',
  });
export type MemberUpdate = z.infer<typeof MemberUpdate>;

// ---- Personal API tokens ----
/** Fixed, scanner-recognisable prefix of every personal API token value. */
export const API_TOKEN_PREFIX = 'ddg_pat_';

export const API_TOKEN_DEFAULT_EXPIRY_DAYS = 90;

export const ApiTokenCreateInput = z.object({
  name: z.string().trim().min(1).max(64),
  expires_in_days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .default(API_TOKEN_DEFAULT_EXPIRY_DAYS),
});
export type ApiTokenCreateInput = z.infer<typeof ApiTokenCreateInput>;

/** POST /tokens result. `token` is the full value and is shown exactly once. */
export const ApiTokenCreated = z.object({
  id: z.string(),
  name: z.string(),
  token: z.string(),
  prefix: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
});
export type ApiTokenCreated = z.infer<typeof ApiTokenCreated>;

/** GET /tokens item — never carries the token value or its hash. */
export const ApiTokenListItem = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  expires_at: z.string(),
});
export type ApiTokenListItem = z.infer<typeof ApiTokenListItem>;

// ---- CSRF ----
/** Fixed custom header every state-changing web-client request carries (AC-50). */
export const CSRF_HEADER = 'x-devdigest-csrf';

// ---- Error codes (stable strings in the existing ApiErrorBody envelope) ----
/** 401 JSON (`unauthenticated`) or `/sign-in?error=<code>` redirects (callback). */
export const AuthErrorCode = z.enum([
  'unauthenticated',
  'auth_state_invalid',
  'auth_token_invalid',
  'auth_domain_not_allowed',
  'auth_email_unverified',
  'auth_account_deactivated',
  'auth_idp_unavailable',
  'auth_disabled',
]);
export type AuthErrorCode = z.infer<typeof AuthErrorCode>;

/** 403 codes. */
export const AuthzErrorCode = z.enum([
  'forbidden_role',
  'forbidden_owner',
  'csrf_rejected',
  'session_required',
]);
export type AuthzErrorCode = z.infer<typeof AuthzErrorCode>;

/** 409 codes. */
export const MembersErrorCode = z.enum(['last_admin', 'token_limit']);
export type MembersErrorCode = z.infer<typeof MembersErrorCode>;

/** 409 (Q4): "<KEY> can't be decrypted — re-enter it in Settings". */
export const SecretErrorCode = z.enum(['secret_undecryptable']);
export type SecretErrorCode = z.infer<typeof SecretErrorCode>;
