import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMutation, useQuery } from "@tanstack/react-query";
import authMessages from "../../messages/en/auth.json";
import { AuthGate } from "@/components/auth-gate";
import { apiError, renderWithProviders, sessionFor, type Routes } from "@/test/render-with-providers";
import { isAuthzCode } from "./providers";
import { useCan } from "./hooks/permissions";
import { errorChannelMeta } from "./query-meta";
import { api } from "./api";
import { navigation, resetSignInRedirect } from "./sign-in-redirect";

/* The global error policy (AC-34, AC-35): 401 → exactly one sign-in redirect
   (never from /sign-in itself); 403 authz → toast + session re-read. One error
   channel per mutation: a `local` mutation never also raises the global toast. */

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

const unauthenticated = () => apiError(401, "unauthenticated", "Sign in");

let assignSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetSignInRedirect();
  assignSpy = vi.spyOn(navigation, "assign").mockImplementation(() => {});
});

afterEach(() => {
  assignSpy.mockRestore();
  window.history.pushState({}, "", "/");
});

function TwoFailingReads() {
  const a = useQuery({ queryKey: ["a"], queryFn: () => api.get("/a"), retry: false });
  const b = useQuery({ queryKey: ["b"], queryFn: () => api.get("/b"), retry: false });
  return <p>{a.isError && b.isError ? "both failed" : "loading"}</p>;
}

/** Shows the role the UI currently gates on, so a session re-read is visible. */
function RoleProbe() {
  const { role } = useCan();
  return <p>role: {role ?? "pending"}</p>;
}

function SaveButton({ local = false }: { local?: boolean }) {
  const save = useMutation({
    mutationFn: () => api.put("/settings", { x: 1 }),
    ...(local ? errorChannelMeta("local") : {}),
  });
  return (
    <>
      <RoleProbe />
      <button type="button" onClick={() => save.mutate()}>
        Save
      </button>
      {save.isError && <p role="alert">inline: save failed</p>}
    </>
  );
}

/** Session answers Member first, then Admin — a re-read flips the visible role. */
function sessionThenPromoted(): Routes {
  let reads = 0;
  return {
    "GET /auth/session": () => (++reads === 1 ? sessionFor("member") : sessionFor("admin")),
  };
}

function renderApp(ui: React.ReactElement, routes: Routes) {
  // Mirrors app/layout.tsx: the gate (session probe) sits inside Providers.
  return renderWithProviders(<AuthGate>{ui}</AuthGate>, { routes });
}

describe("isAuthzCode", () => {
  it("accepts exactly the 403 authz codes", () => {
    for (const code of ["forbidden_role", "forbidden_owner", "csrf_rejected", "session_required"]) {
      expect(isAuthzCode(code)).toBe(true);
    }
    for (const code of [undefined, "", "unauthenticated", "last_admin", "toasts.forbidden_role"]) {
      expect(isAuthzCode(code)).toBe(false);
    }
  });
});

describe("Providers — global auth error policy", () => {
  it("parallel 401s redirect to sign-in exactly once, keeping the current path", async () => {
    nav.pathname = "/repos/r1";
    window.history.pushState({}, "", "/repos/r1?tab=files");

    renderApp(<TwoFailingReads />, { "GET /a": unauthenticated, "GET /b": unauthenticated });

    expect(await screen.findByText("both failed")).toBeInTheDocument();
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith(`/sign-in?return_to=${encodeURIComponent("/repos/r1?tab=files")}`);
  });

  it("never redirects while already on the sign-in screen (no loop)", async () => {
    nav.pathname = "/sign-in";
    window.history.pushState({}, "", "/sign-in?return_to=%2F");

    renderApp(<TwoFailingReads />, {
      "GET /auth/session": unauthenticated,
      "GET /a": unauthenticated,
      "GET /b": unauthenticated,
    });

    expect(await screen.findByText("both failed")).toBeInTheDocument();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("a 403 forbidden_role toasts and re-reads the session without navigating", async () => {
    const user = userEvent.setup();
    nav.pathname = "/settings/api-keys";
    renderApp(<SaveButton />, {
      ...sessionThenPromoted(),
      "PUT /settings": () => apiError(403, "forbidden_role", "Admins only"),
    });

    expect(await screen.findByText("role: member")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(authMessages.toasts.forbidden_role)).toBeInTheDocument();
    expect(await screen.findByText("role: admin")).toBeInTheDocument();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("a `local` mutation's 403 still re-reads the session but raises no toast", async () => {
    const user = userEvent.setup();
    nav.pathname = "/settings/members";
    renderApp(<SaveButton local />, {
      ...sessionThenPromoted(),
      "PUT /settings": () => apiError(403, "forbidden_role", "Admins only"),
    });

    expect(await screen.findByText("role: member")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("inline: save failed");
    expect(await screen.findByText("role: admin")).toBeInTheDocument();
    expect(screen.queryByText(authMessages.toasts.forbidden_role)).not.toBeInTheDocument();
  });

  it("other mutation failures toast globally by default", async () => {
    const user = userEvent.setup();
    nav.pathname = "/";
    renderApp(<SaveButton />, { "PUT /settings": () => apiError(500, "internal", "Engine exploded") });
    await user.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByText("Engine exploded")).toBeInTheDocument();
  });

  it("a `local` mutation's failure is shown only by its caller", async () => {
    const user = userEvent.setup();
    nav.pathname = "/";
    renderApp(<SaveButton local />, { "PUT /settings": () => apiError(500, "internal", "Engine exploded") });
    await user.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("inline: save failed");
    expect(screen.queryByText("Engine exploded")).not.toBeInTheDocument();
  });
});
