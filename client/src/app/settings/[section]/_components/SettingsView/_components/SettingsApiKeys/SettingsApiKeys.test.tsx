import { describe, it, expect } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GitLabTokenHealth, SecretsStatusWithHealth } from "@/lib/types";
import { apiError, renderWithProviders, type RouteRequest } from "@/test/render-with-providers";
import { SettingsApiKeys } from "./SettingsApiKeys";

// Legacy boolean shape (no `states`): the badges fall back to the booleans.
const status: Partial<SecretsStatusWithHealth> = {
  openai: true,
  anthropic: false,
  openrouter: false,
  github: true,
  gitlab: true,
};

describe("SettingsApiKeys", () => {
  it("shows a GitLab token row with the api-scope hint, status and test connection", async () => {
    const user = userEvent.setup();
    const { router } = renderWithProviders(<SettingsApiKeys />, {
      routes: {
        "GET /settings/secrets-status": status,
        "POST /settings/test-connection": (req: RouteRequest) => ({
          provider: (req.body as { provider: string }).provider,
          ok: true,
          message: "Connected as @alice",
        }),
      },
    });

    expect(screen.getByText("GitLab access token")).toBeInTheDocument();
    // AC-27: the hint requires the api scope; the old read_api + read_repository hint is gone.
    expect(screen.getByText("Required scope: api (Reporter role recommended)")).toBeInTheDocument();
    expect(screen.queryByText(/read_api/)).not.toBeInTheDocument();
    expect(await screen.findAllByText("Configured")).toHaveLength(3); // openai, github, gitlab

    expect(screen.getAllByRole("button", { name: "Test connection" })).toHaveLength(5);
    const gitlabRow = screen.getByRole("group", { name: "GitLab access token" });
    await user.type(within(gitlabRow).getByLabelText("GitLab access token"), "glpat-xyz");
    await user.click(within(gitlabRow).getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connected as @alice")).toBeInTheDocument();
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

  it("the GitLab badge shows the stored token's health (AC-26); other rows keep their state", async () => {
    const expected: Record<GitLabTokenHealth, string> = {
      ok: "Configured",
      insufficient_scope: "Invalid — missing api scope",
      invalid: "Invalid — rejected by GitLab",
      unchecked: "Configured — not verified yet",
    };
    for (const [health, text] of Object.entries(expected) as [GitLabTokenHealth, string][]) {
      const { unmount } = renderWithProviders(<SettingsApiKeys />, {
        routes: { "GET /settings/secrets-status": { ...status, gitlab_health: health } },
      });
      const gitlabRow = screen.getByRole("group", { name: "GitLab access token" });
      expect(await within(gitlabRow).findByText(text)).toBeInTheDocument();
      expect(within(screen.getByRole("group", { name: "GitHub PAT (fine-grained)" })).getByText("Configured")).toBeInTheDocument();
      unmount();
    }

    // No stored GitLab token → the plain "Not set" badge, whatever the health field says.
    renderWithProviders(<SettingsApiKeys />, {
      routes: { "GET /settings/secrets-status": { ...status, gitlab: false, gitlab_health: null } },
    });
    const gitlabRow = screen.getByRole("group", { name: "GitLab access token" });
    expect(await within(gitlabRow).findByText("Not set")).toBeInTheDocument();
  });

  it("a missing-api-scope test result is shown as an error with the server message (AC-21)", async () => {
    const user = userEvent.setup();
    const message = "This token is missing the api scope. Required scope: api (Reporter role recommended).";
    renderWithProviders(<SettingsApiKeys />, {
      routes: {
        "GET /settings/secrets-status": { ...status, gitlab_health: "ok" },
        "POST /settings/test-connection": {
          provider: "gitlab",
          ok: false,
          code: "gitlab_token_insufficient_scope",
          message,
        },
      },
    });

    const gitlabRow = screen.getByRole("group", { name: "GitLab access token" });
    await user.type(within(gitlabRow).getByLabelText("GitLab access token"), "glpat-readonly");
    await user.click(within(gitlabRow).getByRole("button", { name: "Test connection" }));
    const result = await within(gitlabRow).findByRole("alert");
    expect(result).toHaveTextContent(message);
  });
});
