/* Pure helpers for the sign-in screen. */
import type { AuthErrorCode } from "@devdigest/shared";
import { ApiError } from "../../../../lib/api";
import { DOMAIN_RE, KNOWN_ERROR_CODES, SIGN_IN_START_PATH } from "./constants";

/** `${apiBase}/auth/google/start[?return_to=…]` — `returnTo` must already be safe. */
export function buildStartHref(apiBase: string, returnTo: string): string {
  const base = `${apiBase}${SIGN_IN_START_PATH}`;
  return returnTo === "/" ? base : `${base}?return_to=${encodeURIComponent(returnTo)}`;
}

/** A printable allowed domain, or null (anything not a bare DNS name is dropped). */
export function cleanDomain(value: unknown): string | null {
  return typeof value === "string" && DOMAIN_RE.test(value) ? value.toLowerCase() : null;
}

/**
 * The allowed domain to name on the signed-out screen. The session probe's 401
 * carries no session, so the domain comes from its error
 * `details.allowed_domain` when the server sends it; otherwise null → the
 * domain-less copy.
 */
export function allowedDomainFromProbe(probeError: unknown): string | null {
  if (!(probeError instanceof ApiError)) return null;
  const details = probeError.details;
  if (!details || typeof details !== "object") return null;
  return cleanDomain((details as Record<string, unknown>).allowed_domain);
}

/** Keys of `auth.errors.*`. */
export type SignInErrorKey = AuthErrorCode | "auth_domain_not_allowed_generic" | "generic";

/**
 * Map the untrusted `?error=` value to an `auth.errors.*` key. The raw value
 * is never rendered: unknown codes → "generic"; the domain message falls back
 * to its domain-less variant when the domain is unknown.
 */
export function errorMessageKey(code: string, domain: string | null): SignInErrorKey {
  if (!KNOWN_ERROR_CODES.has(code)) return "generic";
  if (code === "auth_domain_not_allowed" && !domain) return "auth_domain_not_allowed_generic";
  return code as SignInErrorKey;
}
