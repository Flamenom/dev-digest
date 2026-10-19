import type { SecretState, SecretsStatusDetailed } from "@devdigest/shared";
import type { ConnTestProviderHost } from "@/lib/types";

/**
 * The per-key state for a badge. Prefers the detailed `states` entry
 * (set / unset / undecryptable, AC-38/AC-41) and falls back to the legacy
 * boolean when `states` is absent (older server). `undefined` while loading.
 */
export function keyState(
  status: Partial<SecretsStatusDetailed> | undefined,
  provider: ConnTestProviderHost,
): SecretState | undefined {
  if (!status) return undefined;
  const entry = status.states?.[provider];
  if (entry) return entry.state;
  const configured = status[provider];
  if (configured === undefined) return undefined;
  return configured ? "set" : "unset";
}
