import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CurrentSession, Role } from "@devdigest/shared";
import authMessages from "../../../messages/en/auth.json";
import shellMessages from "../../../messages/en/shell.json";
import { RepoProvider } from "../../lib/repo-context";
import { navigation, resetSignInRedirect } from "@/lib/sign-in-redirect";
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

const fetchMock = vi.fn();
let assignSpy: ReturnType<typeof vi.spyOn>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function session(mode: "local" | "google", role: Role): CurrentSession {
  return {
    mode,
    user: {
      id: "u1",
      email: "ann@onlytraf.com",
      name: mode === "local" ? "Local user" : "Ann Example",
      avatar_url: null,
      role,
    },
    workspace: { id: "w1", name: "Team" },
  };
}

function routeApi(current: CurrentSession) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/auth/session") return json(current);
    if (path === "/auth/sign-out" && init?.method === "POST") return json({ ok: true });
    if (path === "/repos")
      return json([{ id: "r1", full_name: "acme/api", default_branch: "main", last_polled_at: null }]);
    if (path.startsWith("/repos/r1/pulls")) return json([]);
    return json({ error: { code: "not_found", message: "nope" } }, 404);
  });
}

beforeEach(() => {
  resetSignInRedirect();
  router.push.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  assignSpy = vi.spyOn(navigation, "assign").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  assignSpy.mockRestore();
});

function renderShell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale="en" messages={{ auth: authMessages, shell: shellMessages }}>
      <QueryClientProvider client={qc}>
        <RepoProvider>
          <AppShell crumb={[{ label: "Pull Requests" }]}>
            <p>content</p>
          </AppShell>
        </RepoProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

async function openRepoSwitcher() {
  fireEvent.click(await screen.findByText("acme/api"));
}

const menuLabel = (name: string) => authMessages.user.menuLabel.replace("{name}", name);

describe("AppShell identity + repo gating", () => {
  it("google Admin: shows avatar, name, role; Sign out signs out and goes to /sign-in", async () => {
    routeApi(session("google", "admin"));
    renderShell();

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
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/auth\/sign-out$/),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("google Member: remove is hidden; Add repository is inert with a visible 'Admins only' reason", async () => {
    routeApi(session("google", "member"));
    renderShell();

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
    routeApi(session("local", "admin"));
    renderShell();

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
