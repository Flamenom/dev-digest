import { describe, it, expect } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SecretsStatusHost } from "@/lib/types";
import { apiError, renderWithProviders, type RouteRequest } from "@/test/render-with-providers";
import { SettingsApiKeys } from "./SettingsApiKeys";

const status: SecretsStatusHost = {
  openai: true,
  anthropic: false,
  openrouter: false,
  github: true,
  gitlab: true,
};

describe("SettingsApiKeys", () => {
  it("shows a GitLab token row with the minimal-scopes hint, status and test connection", async () => {
    const user = userEvent.setup();
    const { router } = renderWithProviders(<SettingsApiKeys />, {
      routes: {
        "GET /settings/secrets-status": status,
        "POST /settings/test-connection": (req: RouteRequest) => ({
          provider: (req.body as { provider: string }).provider,
          ok: true,
          message: "Token OK (read_api)",
        }),
      },
    });

    expect(screen.getByText("GitLab access token")).toBeInTheDocument();
    const hint = screen.getByText(/read_api/);
    expect(hint).toHaveTextContent("read_repository");
    expect(hint).not.toHaveTextContent(/\bapi\b(?!_)/); // no write-scope wording
    expect(await screen.findAllByText("Configured")).toHaveLength(3); // openai, github, gitlab

    expect(screen.getAllByRole("button", { name: "Test connection" })).toHaveLength(5);
    const gitlabRow = screen.getByRole("group", { name: "GitLab access token" });
    await user.type(within(gitlabRow).getByLabelText("GitLab access token"), "glpat-xyz");
    await user.click(within(gitlabRow).getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Token OK (read_api)")).toBeInTheDocument();
    expect(router.calls.find((c) => c.method === "POST")?.body).toEqual({ provider: "gitlab", key: "glpat-xyz" });
  });

  it("a failed test is shown inline in its row only — no global toast on top", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsApiKeys />, {
      routes: {
        "GET /settings/secrets-status": status,
        "POST /settings/test-connection": () => apiError(502, "upstream", "GitLab is unreachable"),
      },
    });

    const gitlabRow = screen.getByRole("group", { name: "GitLab access token" });
    await user.click(within(gitlabRow).getByRole("button", { name: "Test connection" }));
    expect(await within(gitlabRow).findByText("GitLab is unreachable")).toBeInTheDocument();
    expect(screen.getAllByText("GitLab is unreachable")).toHaveLength(1);
  });
});
