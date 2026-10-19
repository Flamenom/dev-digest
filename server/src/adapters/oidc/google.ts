/**
 * Google OIDC adapter — `IdentityProvider` for the authorization-code flow
 * with PKCE (spec AC-7, AC-8, AC-15).
 *
 * - Endpoints are FIXED constants, never derived from request data.
 * - ID tokens are verified with `jose` against Google's published JWKS
 *   (RS256 only, issuer, audience, exp with 60 s skew, then the nonce in
 *   constant time) before any claim is read.
 * - Failure mapping: network error / timeout / non-2xx from Google (token
 *   endpoint or JWKS) → `auth_idp_unavailable`; any verification failure →
 *   `auth_token_invalid`. Errors carry only the fixed `AuthFlowError` message:
 *   the client secret, the authorization code, the PKCE verifier and the ID
 *   token never reach an error message, a `cause`, or a log line.
 * - The `hd` parameter in the authorization URL only shapes Google's account
 *   chooser. Admission (hd / email_verified / email domain) is decided by the
 *   sign-in service on the verified claims, never here.
 */
import {
  createRemoteJWKSet,
  customFetch,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
} from 'jose';
import type {
  AuthorizationUrlInput,
  CodeExchangeInput,
  CodeExchangeResult,
  IdentityProvider,
  VerifiedIdentity,
  VerifyIdTokenInput,
} from '@devdigest/shared';
import { AuthFlowError } from '../../platform/auth-errors.js';
import { safeEqual } from '../../platform/crypto/tokens.js';

export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
/** Google issues ID tokens with either form of the issuer. */
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/** Spec AC-8: ≤ 60 s clock-skew tolerance. */
export const ID_TOKEN_CLOCK_TOLERANCE_S = 60;
/** At most one JWKS refetch per 60 s on an unknown `kid`. */
export const JWKS_COOLDOWN_MS = 60_000;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Plain options — the composition root maps `AppConfig` onto these. */
export interface GoogleIdentityProviderOptions {
  clientId: string;
  /** Deployment secret. Never logged, never put in an error. */
  clientSecret: string;
  /** Absolute callback URL, e.g. `https://<host>/api/auth/google/callback`. */
  redirectUri: string;
  /** Account-chooser hint (`hd`), e.g. `onlytraf.com`. NOT an admission check. */
  hostedDomain: string;
  /** Injected for hermetic tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Timeout for each call to Google (token endpoint and JWKS). Default 10 s. */
  timeoutMs?: number;
}

/** Thrown inside the JWKS fetch wrapper; mapped to `auth_idp_unavailable`. */
class IdpUnavailable extends Error {
  constructor() {
    super('identity provider unavailable');
    this.name = 'IdpUnavailable';
  }
}

const idpUnavailable = (): AuthFlowError => new AuthFlowError('auth_idp_unavailable');
const tokenInvalid = (): AuthFlowError => new AuthFlowError('auth_token_invalid');

function requireNonEmpty(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`GoogleIdentityProvider: ${name} is required`);
  }
  return value;
}

function stringClaim(payload: JWTPayload, name: string): string | undefined {
  const v = payload[name];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export class GoogleIdentityProvider implements IdentityProvider {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly hostedDomain: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(options: GoogleIdentityProviderOptions) {
    this.clientId = requireNonEmpty(options.clientId, 'clientId');
    this.clientSecret = requireNonEmpty(options.clientSecret, 'clientSecret');
    this.redirectUri = requireNonEmpty(options.redirectUri, 'redirectUri');
    this.hostedDomain = requireNonEmpty(options.hostedDomain, 'hostedDomain');
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;

    this.jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URI), {
      cooldownDuration: JWKS_COOLDOWN_MS,
      timeoutDuration: this.timeoutMs,
      [customFetch]: (url: string, init: RequestInit) => this.fetchJwks(url, init),
    });
  }

  readonly authorizationUrl = (input: AuthorizationUrlInput): string => {
    const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', input.state);
    url.searchParams.set('nonce', input.nonce);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('hd', this.hostedDomain);
    return url.toString();
  };

  readonly exchangeCode = async (input: CodeExchangeInput): Promise<CodeExchangeResult> => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Network error / timeout. The underlying error is dropped on purpose:
      // it may echo request details.
      throw idpUnavailable();
    }

    // Any error answer from Google (5xx, or a 4xx such as invalid_grant) is
    // the retryable "Google returned an error" class (AC-15).
    if (!response.ok) throw idpUnavailable();

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw idpUnavailable();
    }
    const idToken =
      json && typeof json === 'object' ? (json as Record<string, unknown>).id_token : undefined;
    if (typeof idToken !== 'string' || idToken === '') throw idpUnavailable();
    return { idToken };
  };

  readonly verifyIdToken = async (input: VerifyIdTokenInput): Promise<VerifiedIdentity> => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(input.idToken, this.jwks, {
        algorithms: ['RS256'],
        issuer: GOOGLE_ISSUERS,
        audience: this.clientId,
        clockTolerance: ID_TOKEN_CLOCK_TOLERANCE_S,
        requiredClaims: ['sub', 'exp', 'iat'],
      }));
    } catch (err) {
      if (err instanceof IdpUnavailable || err instanceof joseErrors.JWKSTimeout) throw idpUnavailable();
      throw tokenInvalid();
    }

    // Nonce: required, compared in constant time.
    const nonce = stringClaim(payload, 'nonce');
    if (nonce === undefined || typeof input.nonce !== 'string' || input.nonce === '') {
      throw tokenInvalid();
    }
    if (!safeEqual(nonce, input.nonce)) throw tokenInvalid();

    const subject = stringClaim(payload, 'sub');
    const email = stringClaim(payload, 'email');
    if (subject === undefined || email === undefined) throw tokenInvalid();

    const verifiedRaw = payload.email_verified;
    const emailVerified = verifiedRaw === true || verifiedRaw === 'true';

    return {
      subject,
      email,
      emailVerified,
      hostedDomain: stringClaim(payload, 'hd'),
      name: stringClaim(payload, 'name') ?? email,
      avatarUrl: stringClaim(payload, 'picture') ?? null,
    };
  };

  /**
   * JWKS fetch wrapper handed to jose. Any transport problem, non-200 status
   * or malformed body becomes `IdpUnavailable`, so it is not confused with a
   * token that fails verification.
   */
  private async fetchJwks(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') throw err; // jose → JWKSTimeout
      throw new IdpUnavailable();
    }
    if (response.status !== 200) throw new IdpUnavailable();
    let text: string;
    try {
      text = await response.text();
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { keys?: unknown }).keys)) {
        throw new IdpUnavailable();
      }
    } catch {
      throw new IdpUnavailable();
    }
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  }
}
