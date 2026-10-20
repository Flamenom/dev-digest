import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { CurrentSession, Role } from "@devdigest/shared";
import authMessages from "../../../messages/en/auth.json";
import { navigation, resetSignInRedirect } from "@/lib/sign-in-redirect";
import { renderWithProviders, sessionFor, testRepo } from "@/test/render-with-providers";
import { AppShell } from "./AppShell";

/* AC-32: google mode shows avatar, name, role and "Sign out" (which signs out
   and leaves for /sign-in); local mode keeps today's shell (no Sign out).
   AC-33 shell rows: a Member gets no "remove repository" action and an inert
   "Add repository…" with a visible "Admins only" reason. */

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/repos/r1/pulls",
  useRouter: () => router,
}));

let assignSpy: ReturnType<typeof vi.spyOn>;

function session(mode: "local" | "google", role: Role): CurrentSession {
  return sessionFor(role, { mode, userId: "u1", name: mode === "local" ? "Local user" : "Ann Example" });
}

beforeEach(() => {
  resetSignInRedirect();
  router.push.mockReset();
  assignSpy = vi.spyOn(navigation, "assign").mockImplementation(() => {});
});

afterEach(() => assignSpy.mockRestore());

function renderShell(current: CurrentSession) {
  return renderWithProviders(
    <AppShell crumb={[{ label: "Pull Requests" }]}>
      <p>content</p>
    </AppShell>,
    {
      session: current,
      repoProvider: true,
      routes: {
        "GET /repos": [testRepo({ full_name: "acme/api" })],
        "POST /auth/sign-out": { ok: true },
      },
    },
  );
}

async function openRepoSwitcher() {
  fireEvent.click(await screen.findByText("acme/api"));
}

const menuLabel = (name: string) => authMessages.user.menuLabel.replace("{name}", name);

describe("AppShell identity + repo gating", () => {
  it("google Admin: shows avatar, name, role; Sign out signs out and goes to /sign-in", async () => {
    const { router: api } = renderShell(session("google", "admin"));

    const identity = await screen.findByRole("group", { name: menuLabel("Ann Example") });
    expect(within(identity).getByText("AE")).toBeInTheDocument(); // initials avatar (no photo URL)
    expect(within(identity).getByText("Ann Example")).toBeInTheDocument();
    expect(within(identity).getByText(authMessages.roles.admin)).toBeInTheDocument();

    // Admin keeps both repo actions.
    await openRepoSwitcher();
    expect(screen.getByRole("button", { name: "Remove acme/api" })).toBeInTheDocument();
    const adminAdd = screen.getByRole("button", { name: "Add repository…" });
    expect(adminAdd).not.toHaveAttribute("aria-disabled");
    expect(adminAdd).not.toHaveAttribute("aria-describedby");
    fireEvent.click(adminAdd);
    expect(router.push).toHaveBeenCalledWith("/onboarding");

    fireEvent.click(within(identity).getByRole("button", { name: authMessages.user.signOut }));
    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith("/sign-in"));
    expect(api.calls.some((c) => c.method === "POST" && c.path === "/auth/sign-out")).toBe(true);
  });

  it("google Member: remove is hidden; Add repository is inert with a visible 'Admins only' reason", async () => {
    renderShell(session("google", "member"));

    const identity = await screen.findByRole("group", { name: menuLabel("Ann Example") });
    expect(within(identity).getByText(authMessages.roles.member)).toBeInTheDocument();

    await openRepoSwitcher();
    expect(screen.queryByRole("button", { name: "Remove acme/api" })).not.toBeInTheDocument();
    const add = screen.getByRole("button", { name: /Add repository/ });
    expect(add).toHaveAccessibleName(`Add repository… ${authMessages.gate.adminsOnly}`);
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).toHaveAccessibleDescription(authMessages.gate.adminsOnly);
    expect(add).not.toBeDisabled(); // stays focusable
    add.focus();
    expect(add).toHaveFocus();
    fireEvent.click(add);
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Add repository/ })).toBeInTheDocument(); // menu stays open
  });

  it("local mode: no identity block and no Sign out; repo actions unchanged", async () => {
    renderShell(session("local", "admin"));

    await openRepoSwitcher();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove acme/api" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("group", { name: /Local user/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: authMessages.user.signOut })).not.toBeInTheDocument();
    const localAdd = screen.getByRole("button", { name: "Add repository…" });
    expect(localAdd).not.toHaveAttribute("aria-disabled");
    expect(localAdd).not.toHaveAttribute("aria-describedby");
  });
});
