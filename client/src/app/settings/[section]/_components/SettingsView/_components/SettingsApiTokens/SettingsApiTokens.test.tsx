import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ApiTokenCreated, ApiTokenListItem } from "@devdigest/shared";
import settingsMessages from "../../../../../../../../messages/en/settings.json";
import { ApiError } from "@/lib/api";

/* AC-55 (create with name + expiry, value shown exactly once, list shows the
   prefix only) and AC-58 (revoke; `token_limit` message). */

const TOKEN_VALUE = "ddg_pat_abcdefghijklmnopqrstuvwxyz0123456789";
const tokens: ApiTokenListItem[] = [
  {
    id: "t1",
    name: "Laptop MCP",
    prefix: "ddg_pat_abcd",
    created_at: "2026-10-01T10:00:00.000Z",
    last_used_at: null,
    expires_at: "2026-12-30T10:00:00.000Z",
  },
];
const mutateAsync = vi.fn<(input: unknown) => Promise<ApiTokenCreated>>();
const reset = vi.fn();
const revoke = vi.fn();

vi.mock("@/lib/hooks", () => ({
  useApiTokens: () => ({ data: tokens, isPending: false, isError: false }),
  useCreateApiToken: () => ({ mutateAsync, reset, isPending: false }),
  useRevokeApiToken: () => ({ mutate: revoke, isPending: false, isError: false }),
}));

import { SettingsApiTokens } from "./SettingsApiTokens";

beforeEach(() => {
  mutateAsync.mockResolvedValue({
    id: "t2",
    name: "CI box",
    token: TOKEN_VALUE,
    prefix: "ddg_pat_abcd",
    created_at: "2026-10-19T10:00:00.000Z",
    expires_at: "2027-01-17T10:00:00.000Z",
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderTokens() {
  render(
    <NextIntlClientProvider locale="en" messages={{ settings: settingsMessages }}>
      <SettingsApiTokens />
    </NextIntlClientProvider>,
  );
}

describe("SettingsApiTokens", () => {
  it("creates a token with the default 90-day expiry, shows the value once, and clears it on Done", async () => {
    renderTokens();

    const row = screen.getByRole("row", { name: /Laptop MCP/ });
    expect(within(row).getByText("ddg_pat_abcd…")).toBeInTheDocument();
    expect(within(row).getByText("Never")).toBeInTheDocument();
    expect(screen.queryByDisplayValue(TOKEN_VALUE)).not.toBeInTheDocument();

    expect(screen.getByLabelText("Expires in (days)")).toHaveValue(90);
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "  CI box " } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));

    expect(await screen.findByDisplayValue(TOKEN_VALUE)).toBeInTheDocument();
    expect(mutateAsync).toHaveBeenCalledWith({ name: "CI box", expires_in_days: 90 });
    expect(reset).toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Copy your new token now" })).toBeInTheDocument();
    expect(screen.getByLabelText("Token name")).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByDisplayValue(TOKEN_VALUE)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Copy your new token now" })).not.toBeInTheDocument();
  });

  it("validates the form, shows the token_limit message, and revokes a token", async () => {
    renderTokens();

    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    expect(screen.getByRole("alert")).toHaveTextContent(settingsMessages.apiTokens.nameInvalid);
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Expires in (days)"), { target: { value: "366" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    expect(screen.getByRole("alert")).toHaveTextContent(settingsMessages.apiTokens.expiryInvalid);
    expect(mutateAsync).not.toHaveBeenCalled();

    mutateAsync.mockRejectedValueOnce(new ApiError("limit", 409, "token_limit"));
    fireEvent.change(screen.getByLabelText("Expires in (days)"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    expect(await screen.findByText(settingsMessages.apiTokens.errors.token_limit)).toBeInTheDocument();
    expect(mutateAsync).toHaveBeenCalledWith({ name: "x", expires_in_days: 30 });

    fireEvent.click(screen.getByRole("button", { name: "Revoke token Laptop MCP" }));
    expect(revoke).toHaveBeenCalledWith("t1");
  });
});
