import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import authMessages from "../../../messages/en/auth.json";
import { AuthGate } from "./AuthGate";
import { navigation, resetSignInRedirect, safeReturnTo } from "./sign-in-redirect";

/* AC-32 (local half) + AC-35: local mode renders the app untouched; google
   mode with no session redirects once to /sign-in with the return target. */

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

const fetchMock = vi.fn();
let assignSpy: ReturnType<typeof vi.spyOn>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  resetSignInRedirect();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  assignSpy = vi.spyOn(navigation, "assign").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  assignSpy.mockRestore();
  window.history.pushState({}, "", "/");
});

function renderGate() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale="en" messages={{ auth: authMessages }}>
      <QueryClientProvider client={qc}>
        <AuthGate>
          <h1>Studio</h1>
        </AuthGate>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

describe("AuthGate", () => {
  it("local mode: renders the app immediately and stays there (no sign-in redirect)", async () => {
    let resolveProbe!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolveProbe = r)));

    renderGate();
    // Children render before the probe answers.
    expect(screen.getByRole("heading", { name: "Studio" })).toBeInTheDocument();

    resolveProbe(
      json({
        mode: "local",
        user: { id: "sys", email: "local@devdigest", name: "Local", avatar_url: null, role: "admin" },
        workspace: { id: "w1", name: "Default" },
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("heading", { name: "Studio" })).toBeInTheDocument();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("google mode, signed out: hides the app and redirects once with return_to", async () => {
    nav.pathname = "/agents";
    window.history.pushState({}, "", "/agents?tab=evals");
    fetchMock.mockResolvedValue(
      json({ error: { code: "unauthenticated", message: "Sign in" } }, 401),
    );

    renderGate();

    expect(await screen.findByRole("status")).toHaveTextContent(authMessages.signIn.redirecting);
    expect(screen.queryByRole("heading", { name: "Studio" })).not.toBeInTheDocument();
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith("/sign-in?return_to=%2Fagents%3Ftab%3Devals");
  });

  it("only forwards same-origin relative return targets", () => {
    expect(safeReturnTo("/repos/1?x=2")).toBe("/repos/1?x=2");
    for (const bad of ["https://evil.test/", "//evil.test", "/\\evil.test", "repos", "/sign-in?return_to=/x", ""]) {
      expect(safeReturnTo(bad)).toBe("/");
    }
  });
});
