import type { SecretKey } from './adapters.js';
import type { Role } from './contracts/auth.js';
import type { ActorRefValue } from './contracts/actors.js';
import type { SecretState } from './contracts/secrets-status.js';

/**
 * Multi-user server mode — ports (spec SPEC-2026-10-19-multi-user-server).
 * ADDITIVE: `adapters.ts` (`AuthProvider`, `SecretsProvider`) is not edited.
 * Ports are named after the conversation, not the vendor.
 *
 * Soundness: every member is a FUNCTION-TYPED PROPERTY, not a method, so
 * `strictFunctionTypes` checks parameters contravariantly (see host-git.ts).
 * No framework types cross this file: request inputs are structural
 * (`AuthRequestLike`). Transaction handles are an opaque generic `Tx` the
 * infrastructure binds (e.g. a Drizzle transaction) — the application ring
 * only threads it through.
 */

// ---------- Clock ----------
export interface Clock {
  now: () => Date;
}

// ---------- Identity provider (OIDC conversation) ----------
export interface AuthorizationUrlInput {
  /** Opaque single-use state (stored hashed server-side). */
  state: string;
  /** Opaque single-use nonce, echoed back inside the ID token. */
  nonce: string;
  /** PKCE S256 challenge derived from the stored code verifier. */
  codeChallenge: string;
}

export interface CodeExchangeInput {
  code: string;
  codeVerifier: string;
}

export interface CodeExchangeResult {
  /** Raw (unverified) ID token. Never logged. */
  idToken: string;
}

export interface VerifyIdTokenInput {
  idToken: string;
  /** Expected nonce; implementations compare it in constant time. */
  nonce: string;
}

/** Identity built ONLY from verified ID-token claims (AC-11). */
export interface VerifiedIdentity {
  /** Google `sub` — the stable user key. */
  subject: string;
  email: string;
  emailVerified: boolean;
  /** `hd` claim; undefined when absent (consumer accounts). */
  hostedDomain: string | undefined;
  name: string;
  avatarUrl: string | null;
}

/**
 * The redirect URI and client credentials are adapter configuration, not
 * call arguments. Failures are thrown as errors carrying an `AuthErrorCode`
 * `code`: network/5xx → `auth_idp_unavailable`; any verification failure
 * (signature, iss, aud, exp, nonce) → `auth_token_invalid`. Error messages
 * never contain the client secret, the authorization code or the token.
 */
export interface IdentityProvider {
  authorizationUrl: (input: AuthorizationUrlInput) => string;
  exchangeCode: (input: CodeExchangeInput) => Promise<CodeExchangeResult>;
  verifyIdToken: (input: VerifyIdTokenInput) => Promise<VerifiedIdentity>;
}

// ---------- Principal (who is calling, re-read on every request) ----------
export type PrincipalVia = 'local' | 'session' | 'token';

export interface Principal {
  userId: string;
  workspaceId: string;
  role: Role;
  via: PrincipalVia;
  sessionId?: string;
  tokenId?: string;
}

/** Structural request shape — deliberately not a Fastify type. */
export interface AuthRequestLike {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Resolves the caller from a bearer token (wins) or the session cookie.
 * Returns null when unauthenticated; any other failure THROWS (fail closed).
 */
export interface PrincipalProvider {
  resolve: (req: AuthRequestLike) => Promise<Principal | null>;
}

// ---------- Audit (append-only) ----------
/**
 * One audit event. NEVER put secret values, session ids, token values, ID
 * tokens or authorization codes in `metadata` (AC-52).
 */
export interface AuditEventInput {
  workspaceId: string;
  /** null = no authenticated actor (e.g. a rejected sign-in, a boot task). */
  actorUserId: string | null;
  /** Dotted action name, e.g. `member.role_change`, `finding.accept`. */
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export interface AuditLog<Tx = unknown> {
  record: (event: AuditEventInput, tx?: Tx) => Promise<void>;
}

// ---------- Encrypted secret storage (row CRUD; no crypto here) ----------
export interface EncryptedSecretRecord {
  workspaceId: string;
  keyName: string;
  ciphertext: Uint8Array;
  /** 96-bit AES-GCM nonce. */
  nonce: Uint8Array;
  /** Non-reversible id of the master key that encrypted the row. */
  keyId: string;
  updatedAt: Date;
  updatedBy: string | null;
}

export type EncryptedSecretWrite = Omit<EncryptedSecretRecord, 'updatedAt'>;

export interface SecretStore<Tx = unknown> {
  get: (workspaceId: string, keyName: string, tx?: Tx) => Promise<EncryptedSecretRecord | undefined>;
  /** All rows of one workspace, or of every workspace when omitted (rotation scan). */
  list: (workspaceId?: string, tx?: Tx) => Promise<EncryptedSecretRecord[]>;
  /** Insert or replace the row for `(workspaceId, keyName)` atomically. */
  upsert: (record: EncryptedSecretWrite, tx?: Tx) => Promise<void>;
  /** Insert only when no row exists; true when inserted (idempotent import). */
  insertIfAbsent: (record: EncryptedSecretWrite, tx?: Tx) => Promise<boolean>;
  /** Run `fn` in one transaction (rotation re-encrypt, import all-or-nothing). */
  transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

// ---------- Secrets status + write (complements SecretsProvider) ----------
/** Per-key status. Never the value nor anything derived from it. */
export interface SecretKeyStatus {
  state: SecretState;
  updatedAt: Date | null;
  /** Raw user id; presentation enriches it to an `ActorRef`. */
  updatedBy: string | null;
}

export interface SecretsInspector {
  status: (keys: readonly SecretKey[]) => Promise<Map<SecretKey, SecretKeyStatus>>;
}

export interface SecretsWriter {
  set: (key: SecretKey, value: string, actorUserId: string | null) => Promise<void>;
}

// ---------- Actor names (batch lookup; Rec-3) ----------
export interface ActorDirectory {
  /** Unknown ids are absent from the map (render "—"). */
  lookup: (ids: readonly string[]) => Promise<Map<string, ActorRefValue>>;
}
