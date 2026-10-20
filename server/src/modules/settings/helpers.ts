import type {
  ActorRef,
  GitLabTokenHealth,
  SecretState,
  SecretStatusEntry,
  SecretsStatusDetailed,
  SecretsStatusProvider,
  SecretsStatusStates,
  SecretsStatusWithHealth,
  Settings,
} from '@devdigest/shared';

/** A persisted settings key/value row (non-secret prefs). */
export interface SettingsRow {
  key: string;
  value: unknown;
}

/** Collapse key/value setting rows into a flat `Settings` object. */
export function rowsToSettings(rows: SettingsRow[]): Settings {
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = r.value;
  return out as Settings;
}

/** One provider's secret state with the raw updater id (pre actor enrichment). */
export interface ProviderSecretState {
  provider: SecretsStatusProvider;
  state: SecretState;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** A `ProviderSecretState` whose `updated_by` id was resolved to an `ActorRef`. */
export type ProviderSecretStateWithActor = ProviderSecretState & { updated_by: ActorRef };

/** An entry for a provider absent from the input: no value stored, no history. */
const UNSET_ENTRY: SecretStatusEntry = { state: 'unset', updated_at: null, updated_by: null };

/**
 * Build one value per secrets-status provider. The object literal names every
 * provider explicitly, so adding/removing one in the contract fails to compile
 * here instead of being papered over by a cast.
 */
function perProvider<V>(fn: (provider: SecretsStatusProvider) => V): Record<SecretsStatusProvider, V> {
  return {
    openai: fn('openai'),
    anthropic: fn('anthropic'),
    openrouter: fn('openrouter'),
    github: fn('github'),
    gitlab: fn('gitlab'),
  };
}

/**
 * Shape GET /settings/secrets-status (AC-38, Q1): the legacy booleans — `true`
 * ONLY for `set` — plus `states` with state / updated_at / updated_by per
 * provider. Never the value, nor anything derived from it (length, prefix).
 * A provider missing from `entries` is reported `unset`.
 */
export function toSecretsStatusDto(entries: readonly ProviderSecretStateWithActor[]): SecretsStatusDetailed {
  const byProvider = new Map(entries.map((e) => [e.provider, e] as const));
  const states: SecretsStatusStates = perProvider((provider) => {
    const e = byProvider.get(provider);
    if (!e) return UNSET_ENTRY;
    return {
      state: e.state,
      updated_at: e.updatedAt ? e.updatedAt.toISOString() : null,
      updated_by: e.updated_by,
    };
  });
  return { ...perProvider((provider) => states[provider].state === 'set'), states };
}

/**
 * GET /settings/secrets-status plus the GitLab token health (AC-26). `null`
 * health ⇒ no GitLab token configured (plan Q2). Only the health ENUM is added —
 * nothing derived from the token value (no fingerprint, length or prefix).
 */
export function toSecretsStatusWithHealth(
  entries: readonly ProviderSecretStateWithActor[],
  gitlabHealth: GitLabTokenHealth | null,
): SecretsStatusWithHealth {
  return { ...toSecretsStatusDto(entries), gitlab_health: gitlabHealth };
}
