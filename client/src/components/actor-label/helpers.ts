/* Pure helpers for actor rendering (AC-48 labels, avatar URL allowlist). */
import type { ActorRef } from "@devdigest/shared";

export type ActorKind = "none" | "system" | "user";

/** null/absent → "none" ("—"); seeded system user → "system" ("Local user"). */
export function actorKind(actor: ActorRef | undefined): ActorKind {
  if (actor == null) return "none";
  if (actor.is_system) return "system";
  return "user";
}

const AVATAR_HOST_SUFFIX = ".googleusercontent.com";

/**
 * Only `https://*.googleusercontent.com/...` avatars are loaded (Google
 * profile photos). Anything else — other hosts, http, credentials in the URL,
 * `javascript:`/`data:` — gets the default initials avatar.
 */
export function isSafeAvatarUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.port === "" &&
    parsed.hostname.endsWith(AVATAR_HOST_SUFFIX) &&
    parsed.hostname.length > AVATAR_HOST_SUFFIX.length
  );
}
