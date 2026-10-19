import { z } from 'zod';
import { SecretsStatusHost } from './repo-host.js';
import { ActorRef } from './actors.js';

/**
 * Multi-user server mode — detailed secrets status (AC-38, Q1). ADDITIVE:
 * `SecretsStatus` / `SecretsStatusHost` are untouched. GET
 * /settings/secrets-status keeps returning the booleans (true ONLY when the
 * state is `set`) and adds one key, `states`, with a per-provider entry.
 *
 * An entry NEVER carries the value or anything derived from it (length,
 * prefix, last chars, hash): `SecretStatusEntry` is strict, so such a key
 * fails the parse.
 */

export const SecretState = z.enum(['set', 'unset', 'undecryptable']);
export type SecretState = z.infer<typeof SecretState>;

export const SecretStatusEntry = z
  .object({
    state: SecretState,
    /** ISO timestamp of the last save; null when unset or unknown (local mode). */
    updated_at: z.string().nullable(),
    updated_by: ActorRef,
  })
  .strict();
export type SecretStatusEntry = z.infer<typeof SecretStatusEntry>;

/** Provider keys of the secrets status (`openai`, …, `github`, `gitlab`). */
export const SecretsStatusProvider = SecretsStatusHost.keyof();
export type SecretsStatusProvider = z.infer<typeof SecretsStatusProvider>;

export const SecretsStatusStates = z
  .object({
    openai: SecretStatusEntry,
    anthropic: SecretStatusEntry,
    openrouter: SecretStatusEntry,
    github: SecretStatusEntry,
    gitlab: SecretStatusEntry,
  })
  .strict() satisfies z.ZodType<Record<SecretsStatusProvider, SecretStatusEntry>>;
export type SecretsStatusStates = z.infer<typeof SecretsStatusStates>;

export const SecretsStatusDetailed = SecretsStatusHost.extend({
  states: SecretsStatusStates,
});
export type SecretsStatusDetailed = z.infer<typeof SecretsStatusDetailed>;
