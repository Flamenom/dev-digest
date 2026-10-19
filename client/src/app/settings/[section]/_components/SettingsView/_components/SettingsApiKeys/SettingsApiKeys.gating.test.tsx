import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import settingsMessages from "../../../../../../../../messages/en/settings.json";
import authMessages from "../../../../../../../../messages/en/auth.json";
import type { SecretsStatusDetailed } from "@devdigest/shared";

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

vi.mock("@/lib/hooks", () => ({
  useSecretsStatus: () => ({ data: status }),
  useTestConnection: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { SettingsApiKeys } from "./SettingsApiKeys";

afterEach(cleanup);

function renderKeys(readOnly: boolean) {
  render(
    <NextIntlClientProvider locale="en" messages={{ settings: settingsMessages, auth: authMessages }}>
      <SettingsApiKeys readOnly={readOnly} />
    </NextIntlClientProvider>,
  );
}

describe("SettingsApiKeys gating", () => {
  it("Member: badges per key from `states` and the admins-only notice; no inputs or Test buttons", () => {
    renderKeys(true);

    expect(screen.getByRole("note")).toHaveTextContent(authMessages.gate.apiKeysReadOnly);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("OpenAI API key", { selector: "input" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    expect(within(screen.getByRole("group", { name: "OpenAI API key" })).getByText("Configured")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Anthropic API key" })).getByText("Not set")).toBeInTheDocument();
    expect(
      within(screen.getByRole("group", { name: "OpenRouter API key" })).getByText("Needs re-entry"),
    ).toBeInTheDocument();
  });

  it("Admin: editable form unchanged, plus 'Needs re-entry' for an undecryptable key", () => {
    renderKeys(false);

    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Test connection" })).toHaveLength(5);
    const openrouter = screen.getByRole("group", { name: "OpenRouter API key" });
    expect(within(openrouter).getByLabelText("OpenRouter API key")).toBeInTheDocument();
    expect(within(openrouter).getByText("Needs re-entry")).toBeInTheDocument();
    expect(screen.getAllByText("Configured")).toHaveLength(2);
  });
});
