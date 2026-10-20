import React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render-with-providers";
import { RoleProbe, findRole } from "@/test/role-probe";
import { GitLabTokenNotice } from "./GitLabTokenNotice";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/repos/r1/pulls",
  useSearchParams: () => new URLSearchParams(),
}));

const SCOPE_TEXT =
  "The GitLab token is invalid (missing the api scope). An admin must save a token with the api scope in Settings → API Keys.";
const INVALID_TEXT =
  "The GitLab token is invalid (rejected by GitLab). An admin must save a token with the api scope in Settings → API Keys.";

describe("GitLabTokenNotice (AC-25)", () => {
  it("Admin: persistent note with the exact insufficient-scope text and a link to Settings → API Keys", async () => {
    renderWithProviders(
      <>
        <RoleProbe />
        <GitLabTokenNotice id="gitlab-token-notice" health="insufficient_scope" />
      </>,
      { session: "admin" },
    );
    await findRole("admin");

    const note = screen.getByRole("note");
    expect(note).toHaveAttribute("id", "gitlab-token-notice");
    // Not a live region itself — the always-mounted GitLabTokenNoticeRegion announces it.
    expect(note).not.toHaveAttribute("aria-live");
    expect(note).toHaveTextContent(SCOPE_TEXT);
    const link = await screen.findByRole("link", { name: "Open Settings → API Keys" });
    expect(link).toHaveAttribute("href", "/settings/api-keys");
    expect(screen.queryByText("Ask an admin to update it.")).not.toBeInTheDocument();
    // Not dismissible.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("Member: exact invalid-token text, 'Ask an admin to update it.' and no settings link", async () => {
    renderWithProviders(
      <>
        <RoleProbe />
        <GitLabTokenNotice id="gitlab-token-notice" health="invalid" />
      </>,
      { session: "member" },
    );
    await findRole("member");

    const note = screen.getByRole("note");
    expect(note).toHaveTextContent(INVALID_TEXT);
    expect(note).toHaveTextContent("Ask an admin to update it.");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
