import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import authMessages from "../../../messages/en/auth.json";
import { useCan } from "@/lib/hooks/permissions";
import { apiError, renderWithProviders, sessionFor } from "@/test/render-with-providers";
import { AuthGate } from "./AuthGate";
import { navigation, resetSignInRedirect, safeReturnTo } from "@/lib/sign-in-redirect";

/* AC-32 (local half) + AC-35: local mode renders the app untouched; google
   mode with no session redirects once to /sign-in with the return target. */

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

let assignSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetSignInRedirect();
  assignSpy = vi.spyOn(navigation, "assign").mockImplementation(() => {});
});

afterEach(() => {
  assignSpy.mockRestore();
  window.history.pushState({}, "", "/");
});

/** The app under the gate; shows the resolved mode so the probe's answer is visible. */
function Studio() {
  const { mode } = useCan();
  return (
    <>
      <h1>Studio</h1>
      <p>mode: {mode ?? "pending"}</p>
    </>
  );
}

describe("AuthGate", () => {
  it("local mode: renders the app immediately and stays there (no sign-in redirect)", async () => {
    let answerProbe: (value: unknown) => void = () => {};
    const probe = new Promise((resolve) => {
      answerProbe = resolve;
    });
    renderWithProviders(
      <AuthGate>
        <Studio />
      </AuthGate>,
      { routes: { "GET /auth/session": () => probe } },
    );

    // Children render before the probe answers.
    expect(screen.getByRole("heading", { name: "Studio" })).toBeInTheDocument();
    expect(screen.getByText("mode: pending")).toBeInTheDocument();

    answerProbe(sessionFor("admin", { mode: "local" }));
    expect(await screen.findByText("mode: local")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Studio" })).toBeInTheDocument();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("google mode, signed out: hides the app and redirects once with return_to", async () => {
    nav.pathname = "/agents";
    window.history.pushState({}, "", "/agents?tab=evals");

    renderWithProviders(
      <AuthGate>
        <Studio />
      </AuthGate>,
      { routes: { "GET /auth/session": () => apiError(401, "unauthenticated", "Sign in") } },
    );

    expect(await screen.findByText(authMessages.signIn.redirecting)).toBeInTheDocument();
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
