import { AuthErrorCode } from "@devdigest/shared";

/** Server path that starts the Google OIDC flow (accepted Q6), under the API base. */
export const SIGN_IN_START_PATH = "/auth/google/start";

/** `?error=` codes the sign-in screen has a dedicated message for (`auth.errors.<code>`). */
export const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(AuthErrorCode.options);

/** Codes whose message offers a "Try again" action (retryable cause class, AC-15). */
export const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set(["auth_idp_unavailable"]);

/** A bare DNS name (what `allowed_domain` must look like before we print it). */
export const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
