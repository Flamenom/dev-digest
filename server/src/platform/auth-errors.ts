/**
 * Auth / authorization / secrets error taxonomy (spec "Error codes").
 * Extends the base `AppError` envelope from `./errors.ts`. Messages never
 * carry secret values, tokens, codes or key material.
 */
import { AppError } from './errors.js';

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required') {
    super('unauthenticated', message, 401);
  }
}

export class ForbiddenRoleError extends AppError {
  constructor(message = 'This action requires the Admin role') {
    super('forbidden_role', message, 403);
  }
}

export class ForbiddenOwnerError extends AppError {
  constructor(message = 'Only the owner or an Admin can do this') {
    super('forbidden_owner', message, 403);
  }
}

export class CsrfRejectedError extends AppError {
  constructor(message = 'Request rejected by CSRF protection') {
    super('csrf_rejected', message, 403);
  }
}

export class SessionRequiredError extends AppError {
  constructor(message = 'This action requires an interactive session, not an API token') {
    super('session_required', message, 403);
  }
}

export class LastAdminError extends AppError {
  constructor(message = 'The workspace must keep at least one active Admin') {
    super('last_admin', message, 409);
  }
}

export class TokenLimitError extends AppError {
  constructor(limit = 10) {
    super('token_limit', `You already have ${limit} active API tokens — revoke one first`, 409, {
      limit,
    });
  }
}

/** Q4: 409. `keyName` is the managed key's NAME (e.g. `OPENROUTER_API_KEY`), never its value. */
export class SecretUndecryptableError extends AppError {
  constructor(public readonly keyName: string) {
    super(
      'secret_undecryptable',
      `${keyName} can't be decrypted — re-enter it in Settings`,
      409,
      { key: keyName },
    );
  }
}

/** Q6: google-only auth routes in local mode. */
export class AuthDisabledError extends AppError {
  constructor(message = 'Google sign-in is not enabled on this server') {
    super('auth_disabled', message, 404);
  }
}

export const AUTH_FLOW_CODES = [
  'auth_state_invalid',
  'auth_token_invalid',
  'auth_domain_not_allowed',
  'auth_email_unverified',
  'auth_account_deactivated',
  'auth_idp_unavailable',
] as const;
export type AuthFlowCode = (typeof AUTH_FLOW_CODES)[number];

const AUTH_FLOW_MESSAGES: Record<AuthFlowCode, string> = {
  auth_state_invalid: 'The sign-in attempt expired or is invalid — start again',
  auth_token_invalid: 'Google returned an identity token that could not be verified',
  auth_domain_not_allowed: 'Only @onlytraf.com Google accounts can sign in',
  auth_email_unverified: 'Your Google email address is not verified',
  auth_account_deactivated: 'Your account is deactivated — contact an admin',
  auth_idp_unavailable: 'Google sign-in is unavailable right now — try again',
};

export function isAuthFlowCode(value: unknown): value is AuthFlowCode {
  return typeof value === 'string' && (AUTH_FLOW_CODES as readonly string[]).includes(value);
}

/**
 * Sign-in flow failure. The callback route turns it into a redirect to
 * `/sign-in?error=<code>`; `statusCode` applies only if it surfaces as JSON.
 */
export class AuthFlowError extends AppError {
  constructor(
    public readonly flowCode: AuthFlowCode,
    message: string = AUTH_FLOW_MESSAGES[flowCode],
  ) {
    super(flowCode, message, flowCode === 'auth_idp_unavailable' ? 502 : 400);
  }
}
