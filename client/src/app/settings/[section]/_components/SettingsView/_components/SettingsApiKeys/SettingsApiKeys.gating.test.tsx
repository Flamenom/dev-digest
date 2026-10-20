import { describe, it, expect } from "vitest";
import { screen, within } from "@testing-library/react";
import authMessages from "../../../../../../../../messages/en/auth.json";
import type { SecretsStatusDetailed } from "@devdigest/shared";
import { renderWithProviders } from "@/test/render-with-providers";
import { SettingsApiKeys } from "./SettingsApiKeys";

/* AC-33 (Settings → API Keys row) + AC-38/AC-41 UI: a Member gets state badges
   and the read-only notice but no inputs or Test actions; an Admin keeps the
   editable form and sees "Needs re-entry" for an undecryptable key. */

const entry = (state: "set" | "unset" | "undecryptable") => ({ state, updated_at: null, updated_by: null });
const status: SecretsStatusDetailed = {
  openai: true,
  anthropic: false,
  openrouter: false,
  github: true,
  gitlab: false,
  states: {
    openai: entry("set"),
    anthropic: entry("unset"),
    openrouter: entry("undecryptable"),
    github: entry("set"),
    gitlab: entry("unset"),
  },
};

function renderKeys(readOnly: boolean) {
  renderWithProviders(<SettingsApiKeys readOnly={readOnly} />, {
    session: readOnly ? "member" : "admin",
    routes: { "GET /settings/secrets-status": status },
  });
}

describe("SettingsApiKeys gating", () => {
  it("Member: badges per key from `states` and the admins-only notice; no inputs or Test buttons", async () => {
    renderKeys(true);

    const openrouter = screen.getByRole("group", { name: "OpenRouter API key" });
    expect(await within(openrouter).findByText("Needs re-entry")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "OpenAI API key" })).getByText("Configured")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Anthropic API key" })).getByText("Not set")).toBeInTheDocument();

    expect(screen.getByRole("note")).toHaveTextContent(authMessages.gate.apiKeysReadOnly);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("OpenAI API key", { selector: "input" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("Admin: editable form unchanged, plus 'Needs re-entry' for an undecryptable key", async () => {
    renderKeys(false);

    const openrouter = screen.getByRole("group", { name: "OpenRouter API key" });
    expect(await within(openrouter).findByText("Needs re-entry")).toBeInTheDocument();
    expect(within(openrouter).getByLabelText("OpenRouter API key")).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Test connection" })).toHaveLength(5);
    expect(screen.getAllByText("Configured")).toHaveLength(2);
  });
});
