import type { ConnTestProviderHost } from "@/lib/types";
import { GitLabTokenTestCode } from "@devdigest/shared";
import type { GitLabTokenHealth, SecretState } from "@devdigest/shared";

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
  // The `api` scope is required (AC-27; supersedes the read-only scopes hint).
  { provider: "gitlab", labelKey: "apiKeys.gitlabLabel", hintKey: "apiKeys.gitlabHintApi" },
];

/** Badge label per secret state (AC-38, AC-41 "Needs re-entry"). */
export const STATE_LABEL_KEY: Readonly<Record<SecretState, string>> = {
  set: "apiKeys.configured",
  unset: "apiKeys.notSet",
  undecryptable: "apiKeys.needsReentry",
};

/** GitLab row badge label per stored-token health (AC-26). */
export const GITLAB_HEALTH_LABEL_KEY: Readonly<Record<GitLabTokenHealth, string>> = {
  ok: "apiKeys.gitlabHealth.ok",
  insufficient_scope: "apiKeys.gitlabHealth.insufficient_scope",
  invalid: "apiKeys.gitlabHealth.invalid",
  unchecked: "apiKeys.gitlabHealth.unchecked",
};

/** Test-connection result code for a GitLab token without the `api` scope — always shown as an error (AC-21). */
export const GITLAB_SCOPE_ERROR_CODE = GitLabTokenTestCode.enum.gitlab_token_insufficient_scope;
