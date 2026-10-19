import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import authMessages from "../../../../../messages/en/auth.json";
import { API_BASE } from "../../../../lib/api";
import { SignInView } from "./SignInView";

/* AC-6 (single Google action, allowed domain, return target), AC-14
   (deactivated → contact an admin), AC-15 (retryable IdP error), unknown
   `?error=` codes → generic copy, never the raw value. */

const nav = vi.hoisted(() => ({ search: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  usePathname: () => "/sign-in",
}));

const fetchMock = vi.fn();
const START = `${API_BASE}/auth/google/start`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function signedOut(details?: Record<string, unknown>) {
  fetchMock.mockResolvedValue(
    json({ error: { code: "unauthenticated", message: "Sign in", details } }, 401),
  );
}

beforeEach(() => {
  nav.search = "";
  nav.replace.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale="en" messages={{ auth: authMessages }}>
      <QueryClientProvider client={qc}>
        <SignInView />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const subtitleFor = (domain: string) => authMessages.signIn.subtitle.replace("{domain}", domain);

describe("SignInView", () => {
  it("signed out: one Google action carrying the safe return target, naming the allowed domain", async () => {
    nav.search = "return_to=%2Frepos%2Fr1%2Fpulls";
    signedOut({ allowed_domain: "onlytraf.com" });
    renderView();

    expect(await screen.findByRole("heading", { name: authMessages.signIn.title })).toBeInTheDocument();
    expect(screen.getByText(subtitleFor("onlytraf.com"))).toBeInTheDocument();
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName(authMessages.signIn.action);
    expect(links[0]).toHaveAttribute("href", `${START}?return_to=%2Frepos%2Fr1%2Fpulls`);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("drops an off-site return target and falls back to the domain-less copy", async () => {
    nav.search = "return_to=%2F%2Fevil.io";
    signedOut();
    renderView();

    const action = await screen.findByRole("link", { name: authMessages.signIn.action });
    expect(action).toHaveAttribute("href", START);
    expect(screen.getByText(authMessages.signIn.subtitleGeneric)).toBeInTheDocument();
  });

  it("auth_idp_unavailable: retryable error with a Try again action (AC-15)", async () => {
    nav.search = "error=auth_idp_unavailable&return_to=%2Fagents";
    signedOut();
    renderView();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(authMessages.errors.auth_idp_unavailable);
    const retry = screen.getByRole("link", { name: authMessages.signIn.tryAgain });
    expect(retry).toHaveAttribute("href", `${START}?return_to=%2Fagents`);
  });

  it("auth_account_deactivated: tells the user to contact an admin, no retry (AC-14)", async () => {
    nav.search = "error=auth_account_deactivated";
    signedOut();
    renderView();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      authMessages.errors.auth_account_deactivated,
    );
    expect(screen.queryByRole("link", { name: authMessages.signIn.tryAgain })).not.toBeInTheDocument();
  });

  it("an unknown error code shows the generic message, never the raw value", async () => {
    nav.search = `error=${encodeURIComponent("<b>pwned</b>")}`;
    signedOut();
    renderView();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(authMessages.errors.generic);
    expect(alert).not.toHaveTextContent("pwned");
  });

  it("already signed in: goes straight back to the return target", async () => {
    nav.search = "return_to=%2Fskills";
    fetchMock.mockResolvedValue(
      json({
        mode: "google",
        user: { id: "u1", email: "a@onlytraf.com", name: "Ann", avatar_url: null, role: "member" },
        workspace: { id: "w1", name: "Team" },
        allowed_domain: "onlytraf.com",
      }),
    );
    renderView();

    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/skills"));
    expect(screen.queryByRole("link", { name: authMessages.signIn.action })).not.toBeInTheDocument();
  });
});
