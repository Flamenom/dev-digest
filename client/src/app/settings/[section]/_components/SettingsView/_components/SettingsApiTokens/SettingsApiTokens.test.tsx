import { describe, it, expect } from "vitest";
import { screen, fireEvent, within, waitForElementToBeRemoved } from "@testing-library/react";
import type { ApiTokenCreated, ApiTokenListItem } from "@devdigest/shared";
import settingsMessages from "../../../../../../../../messages/en/settings.json";
import { apiError, renderWithProviders, type RouteRequest, type Routes } from "@/test/render-with-providers";
import { SettingsApiTokens } from "./SettingsApiTokens";

/* AC-55 (create with name + expiry, value shown exactly once, list shows the
   prefix only) and AC-58 (revoke; `token_limit` message). Form failures are
   shown inline only — never also as a global toast. */

const TOKEN_VALUE = "ddg_pat_abcdefghijklmnopqrstuvwxyz0123456789";
const LAPTOP: ApiTokenListItem = {
  id: "t1",
  name: "Laptop MCP",
  prefix: "ddg_pat_abcd",
  created_at: "2026-10-01T10:00:00.000Z",
  last_used_at: null,
  expires_at: "2026-12-30T10:00:00.000Z",
};

/** In-memory tokens API: POST adds a token (and returns its value once), DELETE revokes. */
function tokensApi(extra: Routes = {}): Routes {
  let tokens: ApiTokenListItem[] = [LAPTOP];
  return {
    "GET /tokens": () => tokens,
    "POST /tokens": (req: RouteRequest): ApiTokenCreated => {
      const { name } = req.body as { name: string };
      const created = {
        id: "t2",
        name,
        prefix: "ddg_pat_wxyz",
        created_at: "2026-10-19T10:00:00.000Z",
        last_used_at: null,
        expires_at: "2027-01-17T10:00:00.000Z",
      };
      tokens = [...tokens, created];
      return { ...created, token: TOKEN_VALUE };
    },
    "DELETE /tokens/:id": (req: RouteRequest) => {
      tokens = tokens.filter((tk) => tk.id !== req.params.id);
      return { ok: true };
    },
    ...extra,
  };
}

describe("SettingsApiTokens", () => {
  it("creates a token with the default 90-day expiry, shows the value once, and clears it on Done", async () => {
    const { router } = renderWithProviders(<SettingsApiTokens />, { routes: tokensApi() });

    const row = await screen.findByRole("row", { name: /Laptop MCP/ });
    expect(within(row).getByText("ddg_pat_abcd…")).toBeInTheDocument();
    expect(within(row).getByText("Never")).toBeInTheDocument();
    expect(screen.queryByDisplayValue(TOKEN_VALUE)).not.toBeInTheDocument();

    expect(screen.getByLabelText("Expires in (days)")).toHaveValue(90);
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "  CI box " } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));

    expect(await screen.findByDisplayValue(TOKEN_VALUE)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Copy your new token now" })).toBeInTheDocument();
    expect(screen.getByLabelText("Token name")).toHaveValue("");
    // The list re-reads and shows the new token by its prefix only.
    expect(await screen.findByRole("row", { name: /CI box/ })).toHaveTextContent("ddg_pat_wxyz…");
    expect(router.calls.find((c) => c.method === "POST")?.body).toEqual({ name: "CI box", expires_in_days: 90 });

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByDisplayValue(TOKEN_VALUE)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Copy your new token now" })).not.toBeInTheDocument();
  });

  it("validates the form, shows the token_limit message inline only, and revokes a token", async () => {
    const { router } = renderWithProviders(<SettingsApiTokens />, {
      routes: tokensApi({ "POST /tokens": () => apiError(409, "token_limit", "Too many tokens") }),
    });
    await screen.findByRole("row", { name: /Laptop MCP/ });

    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    expect(screen.getByRole("alert")).toHaveTextContent(settingsMessages.apiTokens.nameInvalid);
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Expires in (days)"), { target: { value: "366" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    expect(screen.getByRole("alert")).toHaveTextContent(settingsMessages.apiTokens.expiryInvalid);
    expect(router.calls.some((c) => c.method === "POST")).toBe(false);

    fireEvent.change(screen.getByLabelText("Expires in (days)"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    expect(await screen.findByText(settingsMessages.apiTokens.errors.token_limit)).toBeInTheDocument();
    expect(screen.queryByText("Too many tokens")).not.toBeInTheDocument();
    expect(router.calls.find((c) => c.method === "POST")?.body).toEqual({ name: "x", expires_in_days: 30 });

    fireEvent.click(screen.getByRole("button", { name: "Revoke token Laptop MCP" }));
    await waitForElementToBeRemoved(() => screen.queryByRole("row", { name: /Laptop MCP/ }));
  });

  it("a failed revoke is shown inline in its row only — no global toast on top", async () => {
    renderWithProviders(<SettingsApiTokens />, {
      routes: tokensApi({ "DELETE /tokens/:id": () => apiError(500, "internal", "db down") }),
    });

    const row = await screen.findByRole("row", { name: /Laptop MCP/ });
    fireEvent.click(within(row).getByRole("button", { name: "Revoke token Laptop MCP" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent(settingsMessages.apiTokens.errors.revoke);
    expect(screen.queryByText("db down")).not.toBeInTheDocument();
  });
});
