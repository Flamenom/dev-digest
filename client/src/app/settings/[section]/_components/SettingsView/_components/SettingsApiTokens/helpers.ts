import { ApiError } from "@/lib/api";
import type { CreateApiTokenInput } from "@/lib/hooks";
import { TOKEN_EXPIRY_MAX_DAYS, TOKEN_EXPIRY_MIN_DAYS, TOKEN_NAME_MAX } from "./constants";

export type TokenFormResult =
  | { ok: true; input: CreateApiTokenInput }
  | { ok: false; errorKey: "apiTokens.nameInvalid" | "apiTokens.expiryInvalid" };

/** Validate the create form (name 1–64 after trim, expiry a whole number of days 1–365, AC-55). */
export function validateTokenForm(name: string, days: string): TokenFormResult {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > TOKEN_NAME_MAX) {
    return { ok: false, errorKey: "apiTokens.nameInvalid" };
  }
  const n = Number(days.trim());
  if (!/^\d+$/.test(days.trim()) || n < TOKEN_EXPIRY_MIN_DAYS || n > TOKEN_EXPIRY_MAX_DAYS) {
    return { ok: false, errorKey: "apiTokens.expiryInvalid" };
  }
  return { ok: true, input: { name: trimmed, expires_in_days: n } };
}

/** i18n key for a failed create; `token_limit` is the 10-active-tokens 409 (AC-58). */
export function createErrorKey(err: unknown): string {
  if (err instanceof ApiError && err.code === "token_limit") return "apiTokens.errors.token_limit";
  return "apiTokens.errors.create";
}
