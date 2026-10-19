import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../../../../../../messages/en/settings.json";
import type { SecretsStatusHost } from "@/lib/types";

const mutateAsync = vi.fn();
const status: SecretsStatusHost = {
  openai: true,
  anthropic: false,
  openrouter: false,
  github: true,
  gitlab: true,
};
vi.mock("@/lib/hooks", () => ({
  useSecretsStatus: () => ({ data: status }),
  useTestConnection: () => ({ mutateAsync, isPending: false }),
}));

import { SettingsApiKeys } from "./SettingsApiKeys";

afterEach(() => {
  cleanup();
  mutateAsync.mockReset();
});

function renderKeys() {
  render(
    <NextIntlClientProvider locale="en" messages={{ settings: messages }}>
      <SettingsApiKeys />
    </NextIntlClientProvider>,
  );
}

describe("SettingsApiKeys", () => {
  it("shows a GitLab token row with the minimal-scopes hint, status and test connection", async () => {
    mutateAsync.mockResolvedValue({ provider: "gitlab", ok: true, message: "Token OK (read_api)" });
    renderKeys();

    expect(screen.getByText("GitLab access token")).toBeInTheDocument();
    const hint = screen.getByText(/read_api/);
    expect(hint).toHaveTextContent("read_repository");
    expect(hint).not.toHaveTextContent(/\bapi\b(?!_)/); // no write-scope wording
    expect(screen.getAllByText("Configured")).toHaveLength(3); // openai, github, gitlab

    expect(screen.getAllByRole("button", { name: "Test connection" })).toHaveLength(5);
    const gitlabRow = screen.getByRole("group", { name: "GitLab access token" });
    fireEvent.change(within(gitlabRow).getByLabelText("GitLab access token"), {
      target: { value: "glpat-xyz" },
    });
    fireEvent.click(within(gitlabRow).getByRole("button", { name: "Test connection" }));
    expect(mutateAsync).toHaveBeenCalledWith({ provider: "gitlab", key: "glpat-xyz" });
    expect(await screen.findByText("Token OK (read_api)")).toBeInTheDocument();
  });
});
