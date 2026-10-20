import React from "react";
import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Checkbox } from "@devdigest/ui";
import { renderWithProviders, sessionFor } from "@/test/render-with-providers";
import { AdminHint } from "./AdminHint";
import { useAdminHint } from "./useAdminHint";

/* useAdminHint + AdminHint: a list's Admin-only controls are inert until the
   session resolves (fail closed); the visible "Admins only" reason (and the
   aria-describedby link to it) appears only once the user is KNOWN to be a
   Member — never as a flash for an Admin while the probe is in flight. */

function GatedList({ reason }: { reason?: string }) {
  const hint = useAdminHint();
  return (
    <>
      <AdminHint hint={hint}>{reason}</AdminHint>
      <Checkbox checked={false} label="Attach" aria-disabled={hint.readOnly} aria-describedby={hint.describedBy} />
    </>
  );
}

describe("useAdminHint / AdminHint", () => {
  it("Member: controls inert and described by the visible hint (default or custom text)", async () => {
    renderWithProviders(<GatedList />, { session: "member" });
    const box = screen.getByRole("checkbox", { name: "Attach" });
    await waitFor(() => expect(box).toHaveAccessibleDescription("Admins only"));
    expect(box).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Admins only")).toBeVisible();
  });

  it("Member with a custom reason: that text is the description", async () => {
    renderWithProviders(<GatedList reason="Only admins can change this." />, { session: "member" });
    const box = screen.getByRole("checkbox", { name: "Attach" });
    await waitFor(() => expect(box).toHaveAccessibleDescription("Only admins can change this."));
    expect(screen.queryByText("Admins only")).not.toBeInTheDocument();
  });

  it("session pending: inert, but no hint and no description", () => {
    renderWithProviders(<GatedList />, {
      routes: { "GET /auth/session": () => new Promise(() => {}) },
    });
    const pendingBox = screen.getByRole("checkbox", { name: "Attach" });
    expect(pendingBox).toHaveAttribute("aria-disabled", "true");
    expect(pendingBox).not.toHaveAccessibleDescription();
    expect(screen.queryByText("Admins only")).not.toBeInTheDocument();
  });

  it("Admin: live and no hint once the session resolves", async () => {
    renderWithProviders(<GatedList />, { session: sessionFor("admin") });
    const box = screen.getByRole("checkbox", { name: "Attach" });
    await waitFor(() => expect(box).not.toHaveAttribute("aria-disabled"));
    expect(box).not.toHaveAccessibleDescription();
    expect(screen.queryByText("Admins only")).not.toBeInTheDocument();
  });
});
