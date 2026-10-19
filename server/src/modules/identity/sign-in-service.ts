/**
 * SignInService — the Google OIDC sign-in use case (google mode).
 * Spec SPEC-2026-10-19-multi-user-server, AC-7 … AC-18, AC-24, AC-52.
 *
 * `start` mints a single-use flow (state + nonce + PKCE verifier + browser
 * binding, 10-minute TTL). `callback` runs, in this order and failing closed:
 *
 *   1. consume the flow — missing / mismatched binding / reused / expired
 *      → `auth_state_invalid` (AC-7);
 *   2. exchange the code — any failure → `auth_idp_unavailable` (AC-15);
 *   3. verify the ID token — any failure → `auth_token_invalid` (AC-8)
 *      (a JWKS outage stays `auth_idp_unavailable`);
 *   4. admission on VERIFIED claims only (AC-9, AC-10): `hd` equals the
 *      allowed domain, the email's domain equals it exactly
 *      (case-insensitive, no subdomain / suffix match), `email_verified`
 *      is `true` → else `auth_domain_not_allowed` / `auth_email_unverified`;
 *   5. under the workspace membership lock (one transaction): a deactivated
 *      member → `auth_account_deactivated` with NO write (AC-14); upsert the
 *      user by Google `sub` (AC-11/12/13), ensure the membership — Admin iff
 *      allowlisted AND (first join OR zero active Admins) (AC-17), never a
 *      demotion (AC-18) — rotate the session (AC-24) and audit `auth.sign_in`.
 *
 * Every rejection is audited as `auth.sign_in_rejected` with `reason` (the
 * flow code) and the verified email when present (AC-52). Nothing a request
 * supplies besides `code`, `state` and the two cookies is read (AC-10).
 * Raw state / binding / session values only ever reach the repository HASHED.
 */
import type { AuditLog, Clock, IdentityProvider, Role, VerifiedIdentity } from '@devdigest/shared';
import { AuthFlowError, type AuthFlowCode } from '../../platform/auth-errors.js';
import { safeReturnTo } from '../../platform/auth/return-to.js';
import {
  codeChallengeS256,
  codeVerifier,
  newSessionId,
  randomToken,
  safeEqual,
  sha256Hex,
} from '../../platform/crypto/tokens.js';
import type { IdentityRepository, IdentityTx } from './repository.js';

/** Max accepted length of `code` / `state` / cookie values (defensive bound). */
const MAX_INPUT_LENGTH = 4096;

/** The slice of {@link IdentityRepository} the sign-in flow needs (fakes implement just this). */
export interface SignInRepository {
  users: Pick<IdentityRepository['users'], 'findBySub' | 'upsertBySub'>;
  memberships: Pick<
    IdentityRepository['memberships'],
    'get' | 'ensureMember' | 'countActiveAdmins' | 'setRole'
  >;
  sessions: Pick<IdentityRepository['sessions'], 'create' | 'deleteByHash'>;
  oauthFlows: Pick<IdentityRepository['oauthFlows'], 'create' | 'consume'>;
  withWorkspaceLock: <T>(workspaceId: string, fn: (tx: IdentityTx) => Promise<T>) => Promise<T>;
}

export interface SignInConfig {
  /** Lower-case admitted domain, e.g. `onlytraf.com`. */
  allowedDomain: string;
  /** Lower-case admin allowlist (`AUTH_ADMIN_EMAILS`). */
  adminEmails: readonly string[];
}

export interface SignInServiceDeps {
  repo: SignInRepository;
  idp: IdentityProvider;
  audit: AuditLog<IdentityTx>;
  clock: Clock;
  config: SignInConfig;
  /** The single team workspace every admitted user joins. */
  workspace: { id: string };
}

export interface SignInStartResult {
  /** Where to 302 the browser (Google's authorization endpoint). */
  authorizationUrl: string;
  /** Value for the `__Host-ddg_oauth` binding cookie (only its hash is stored). */
  bindingValue: string;
}

export interface SignInCallbackInput {
  code?: string | undefined;
  state?: string | undefined;
  /** The `__Host-ddg_oauth` cookie the browser sent back. */
  bindingValue?: string | undefined;
  /** The session cookie the browser already held, if any — discarded (AC-24). */
  previousSessionValue?: string | undefined;
  ip?: string | null | undefined;
}

export interface SignInCallbackResult {
  /** Value for the `__Host-ddg_session` cookie (only its hash is stored). */
  sessionValue: string;
  /** Validated same-origin relative path (AC-16). */
  returnTo: string;
  userId: string;
  role: Role;
}

export interface SignOutInput {
  sessionValue?: string | undefined;
  actorUserId: string | null;
  ip?: string | null | undefined;
}

/** Postgres unique violation, matched by SHAPE (postgres-js `code`, maybe wrapped in `cause`). */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 3; depth++) {
    if (typeof e === 'object' && (e as { code?: unknown }).code === '23505') return true;
    e = typeof e === 'object' ? (e as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/** The flow code of an error thrown by the IdP port, matched by shape. */
function flowCodeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { code } = err as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

function usable(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_INPUT_LENGTH;
}

/** Exactly one `@`, non-empty local part, domain equal to `domain` (case-insensitive). */
function emailInDomain(email: string, domain: string): boolean {
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return false;
  return email.slice(at + 1).toLowerCase() === domain;
}

/** A rejected sign-in: carries the audit details out of the flow. */
class Rejection extends Error {
  constructor(
    readonly flowCode: AuthFlowCode,
    readonly email: string | null,
    /** Finer-grained audit reason when it differs from the flow code. */
    readonly detail?: string,
  ) {
    super(flowCode);
  }
}

export class SignInService {
  private readonly allowedDomain: string;
  private readonly adminEmails: ReadonlySet<string>;

  constructor(private readonly deps: SignInServiceDeps) {
    this.allowedDomain = deps.config.allowedDomain.toLowerCase();
    this.adminEmails = new Set(deps.config.adminEmails.map((e) => e.toLowerCase()));
  }

  /** Begin a sign-in (AC-7): persist the flow hashed, return Google's URL + binding cookie value. */
  async start(input: { returnTo?: unknown } = {}): Promise<SignInStartResult> {
    const state = randomToken();
    const nonce = randomToken();
    const verifier = codeVerifier();
    const bindingValue = randomToken();
    await this.deps.repo.oauthFlows.create({
      stateHash: sha256Hex(state),
      bindingHash: sha256Hex(bindingValue),
      nonce,
      codeVerifier: verifier,
      returnTo: safeReturnTo(input.returnTo),
      now: this.deps.clock.now(),
    });
    const authorizationUrl = this.deps.idp.authorizationUrl({
      state,
      nonce,
      codeChallenge: codeChallengeS256(verifier),
    });
    return { authorizationUrl, bindingValue };
  }

  /**
   * Complete a sign-in. Throws `AuthFlowError` (the route redirects to
   * `/sign-in?error=<code>`); any other error is infrastructure and propagates.
   */
  async callback(input: SignInCallbackInput): Promise<SignInCallbackResult> {
    try {
      return await this.admit(input);
    } catch (err) {
      if (!(err instanceof Rejection)) throw err;
      await this.deps.audit.record({
        workspaceId: this.deps.workspace.id,
        actorUserId: null,
        action: 'auth.sign_in_rejected',
        targetType: 'user',
        targetId: null,
        metadata: {
          reason: err.detail ?? err.flowCode,
          ...(err.email !== null ? { email: err.email } : {}),
        },
        ip: input.ip ?? null,
      });
      // The browser only ever sees the generic flow-code text; the finer
      // `detail` (e.g. email_conflict) stays in the audit row — it would tell
      // an outsider that a member with this email exists.
      throw new AuthFlowError(err.flowCode);
    }
  }

  /** Sign out (AC-26): delete the session server-side and audit it. Idempotent. */
  async signOut(input: SignOutInput): Promise<void> {
    if (!usable(input.sessionValue)) return;
    const deleted = await this.deps.repo.sessions.deleteByHash(sha256Hex(input.sessionValue));
    if (!deleted) return;
    await this.deps.audit.record({
      workspaceId: this.deps.workspace.id,
      actorUserId: input.actorUserId,
      action: 'auth.sign_out',
      targetType: 'user',
      targetId: input.actorUserId,
      ip: input.ip ?? null,
    });
  }

  private async admit(input: SignInCallbackInput): Promise<SignInCallbackResult> {
    const now = this.deps.clock.now();

    // 1. Single-use, browser-bound, unexpired flow (AC-7).
    if (!usable(input.state)) throw new Rejection('auth_state_invalid', null);
    const flow = await this.deps.repo.oauthFlows.consume(sha256Hex(input.state), now);
    if (!flow || flow.expiresAt.getTime() <= now.getTime()) {
      throw new Rejection('auth_state_invalid', null);
    }
    if (!usable(input.bindingValue) || !safeEqual(sha256Hex(input.bindingValue), flow.bindingHash)) {
      throw new Rejection('auth_state_invalid', null);
    }
    // No code with a valid state ⇒ Google returned an error (consent denied, …) (AC-15).
    if (!usable(input.code)) throw new Rejection('auth_idp_unavailable', null);

    // 2. Code exchange (PKCE).
    let idToken: string;
    try {
      ({ idToken } = await this.deps.idp.exchangeCode({
        code: input.code,
        codeVerifier: flow.codeVerifier,
      }));
    } catch {
      throw new Rejection('auth_idp_unavailable', null);
    }

    // 3. Verification — no claim is read before this succeeds (AC-8).
    let identity: VerifiedIdentity;
    try {
      identity = await this.deps.idp.verifyIdToken({ idToken, nonce: flow.nonce });
    } catch (err) {
      const code = flowCodeOf(err) === 'auth_idp_unavailable' ? 'auth_idp_unavailable' : 'auth_token_invalid';
      throw new Rejection(code, null);
    }

    // 4. Admission on verified claims only (AC-9, AC-10).
    const email = identity.email.trim();
    const emailForAudit = identity.emailVerified === true ? email : null;
    const domainOk =
      typeof identity.hostedDomain === 'string' &&
      identity.hostedDomain.toLowerCase() === this.allowedDomain &&
      emailInDomain(email, this.allowedDomain);
    if (!domainOk) throw new Rejection('auth_domain_not_allowed', emailForAudit);
    if (identity.emailVerified !== true) throw new Rejection('auth_email_unverified', null);
    if (!usable(identity.subject)) throw new Rejection('auth_token_invalid', emailForAudit);

    // 5. Join + session, serialized per workspace (AC-13, AC-17).
    const workspaceId = this.deps.workspace.id;
    const allowlisted = this.adminEmails.has(email.toLowerCase());
    const sessionValue = newSessionId();

    const outcome = await this.deps.repo.withWorkspaceLock(workspaceId, async (tx) => {
      const { users, memberships, sessions } = this.deps.repo;

      const known = await users.findBySub(identity.subject, tx);
      if (known) {
        const existing = await memberships.get(workspaceId, known.id, tx);
        if (existing && existing.status !== 'active') {
          throw new Rejection('auth_account_deactivated', email);
        }
      }

      const activeAdmins = allowlisted ? await memberships.countActiveAdmins(workspaceId, tx) : null;

      let upserted;
      try {
        upserted = await users.upsertBySub(
          {
            subject: identity.subject,
            email,
            name: identity.name,
            avatarUrl: identity.avatarUrl,
          },
          now,
          tx,
        );
      } catch (err) {
        // Another Google account already owns this email (a re-created account
        // with a new `sub`). Never merge identities by email — reject (T7 gap).
        if (!isUniqueViolation(err)) throw err;
        throw new Rejection('auth_token_invalid', email, 'email_conflict');
      }
      const user = upserted.user;

      const ensured = await memberships.ensureMember(
        workspaceId,
        user.id,
        allowlisted ? 'admin' : 'member',
        now,
        tx,
      );
      let membership = ensured.membership;
      // Belt and braces: the membership must be active (rolls the upsert back).
      if (membership.status !== 'active') throw new Rejection('auth_account_deactivated', email);

      // AC-17 recovery: an allowlisted existing member is promoted ONLY when the
      // workspace has no active Admin. Never demotes, never overrides a UI role (AC-18).
      let promoted = false;
      if (!ensured.created && allowlisted && activeAdmins === 0 && membership.role !== 'admin') {
        membership = (await memberships.setRole(workspaceId, user.id, 'admin', tx)) ?? membership;
        promoted = true;
      }

      // AC-24: discard the session the browser held before, issue a fresh one.
      if (usable(input.previousSessionValue)) {
        await sessions.deleteByHash(sha256Hex(input.previousSessionValue), tx);
      }
      await sessions.create({ idHash: sha256Hex(sessionValue), userId: user.id, workspaceId, now }, tx);

      await this.deps.audit.record(
        {
          workspaceId,
          actorUserId: user.id,
          action: 'auth.sign_in',
          targetType: 'user',
          targetId: user.id,
          metadata: {
            first_sign_in: upserted.created,
            joined: ensured.created,
            role: membership.role,
            ...(promoted ? { promoted_by_allowlist: true } : {}),
          },
          ip: input.ip ?? null,
        },
        tx,
      );
      return { userId: user.id, role: membership.role };
    });

    return { sessionValue, returnTo: safeReturnTo(flow.returnTo), ...outcome };
  }
}
