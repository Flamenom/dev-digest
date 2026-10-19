/**
 * Provider → managed SecretKey map. Lives in `platform/` (not a feature
 * module) because it is cross-cutting: the composition root, the route
 * policy, the secrets-import CLI and the settings module all need it, and
 * platform code must not import feature modules. The settings constants file
 * re-exports it for existing callers.
 */
import type { ConnTestProviderHost, SecretKey } from '@devdigest/shared';

/** Maps a connection-test provider to the SecretsProvider key it persists to. */
export const SECRET_KEY_BY_PROVIDER: Record<ConnTestProviderHost, SecretKey> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  github: 'GITHUB_TOKEN',
  gitlab: 'GITLAB_TOKEN',
};
