import type { ConnTestProviderHost } from "@/lib/types";
import type { SecretState } from "@devdigest/shared";

/** One configurable provider key row in the API Keys section. */
export interface KeyRowSpec {
  provider: ConnTestProviderHost;
  labelKey: string;
  hintKey: string;
}

/** The provider key rows shown in API Keys (OpenAI / Anthropic / OpenRouter /
 *  GitHub / GitLab). One token per provider per workspace (AC-1). */
export const KEY_ROWS: readonly KeyRowSpec[] = [
  { provider: "openai", labelKey: "apiKeys.openaiLabel", hintKey: "apiKeys.openaiHint" },
  { provider: "anthropic", labelKey: "apiKeys.anthropicLabel", hintKey: "apiKeys.anthropicHint" },
  { provider: "openrouter", labelKey: "apiKeys.openrouterLabel", hintKey: "apiKeys.openrouterHint" },
  { provider: "github", labelKey: "apiKeys.githubLabel", hintKey: "apiKeys.githubHint" },
  // Minimal read-only scopes hint (AC-53): read_api + read_repository.
  { provider: "gitlab", labelKey: "apiKeys.gitlabLabel", hintKey: "apiKeys.gitlabHint" },
];

/** Badge label per secret state (AC-38, AC-41 "Needs re-entry"). */
export const STATE_LABEL_KEY: Readonly<Record<SecretState, string>> = {
  set: "apiKeys.configured",
  unset: "apiKeys.notSet",
  undecryptable: "apiKeys.needsReentry",
};
