import { ApiError } from "@/lib/api";

/** i18n key (settings namespace) for a failed member update; `last_admin` is the AC-22 guard. */
export function memberErrorKey(err: unknown): string {
  if (err instanceof ApiError && err.code === "last_admin") return "members.errors.last_admin";
  return "members.errors.generic";
}
