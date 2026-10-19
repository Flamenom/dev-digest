import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { useMutation, useQuery } from "@tanstack/react-query";
import authMessages from "../../messages/en/auth.json";
import { Providers } from "./providers";
import { api } from "./api";
import {
  navigation,
  resetSignInRedirect,
} from "./sign-in-redirect";

/* The global error policy (AC-34, AC-35): 401 → exactly one sign-in redirect
   (never from /sign-in itself); 403 authz → toast + session re-read. */

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

const MEMBER_SESSION = {
  mode: "google",
  user: { id: "u1", email: "a@onlytraf.com", name: "Ann", avatar_url: null, role: "member" },
  workspace: { id: "w1", name: "Team" },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const unauthenticated = () =>
  json({ error: { code: "unauthenticated", message: "Sign in" } }, 401);

const fetchMock = vi.fn();
let assignSpy: ReturnType<typeof vi.spyOn>;

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

/** Route the mocked API by path; `/auth/session` + `/repos` answer by default. */
function routeApi(routes: Record<string, () => Response>) {
  fetchMock.mockImplementation((url: string) => {
    const path = new URL(url).pathname;
    const hit = routes[path];
    if (hit) return Promise.resolve(hit());
    if (path === "/auth/session") return Promise.resolve(json(MEMBER_SESSION));
    if (path === "/repos") return Promise.resolve(json([]));
    return Promise.resolve(json({}));
  });
}

function sessionCalls() {
  return fetchMock.mock.calls.filter(([u]) => new URL(u as string).pathname === "/auth/session")
    .length;
}

function TwoFailingReads() {
  const a = useQuery({ queryKey: ["a"], queryFn: () => api.get("/a"), retry: false });
  const b = useQuery({ queryKey: ["b"], queryFn: () => api.get("/b"), retry: false });
  return <p>{a.isError && b.isError ? "both failed" : "loading"}</p>;
}

function SaveButton() {
  const save = useMutation({ mutationFn: () => api.put("/settings", { x: 1 }) });
  return (
    <button type="button" onClick={() => save.mutate()}>
      Save
    </button>
  );
}

function renderApp(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ auth: authMessages }}>
      <Providers>{ui}</Providers>
    </NextIntlClientProvider>,
  );
}

describe("Providers — global auth error policy", () => {
  it("parallel 401s redirect to sign-in exactly once, keeping the current path", async () => {
    nav.pathname = "/repos/r1";
    window.history.pushState({}, "", "/repos/r1?tab=files");
    routeApi({ "/a": unauthenticated, "/b": unauthenticated });

    renderApp(<TwoFailingReads />);

    expect(await screen.findByText("both failed")).toBeInTheDocument();
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith(
      `/sign-in?return_to=${encodeURIComponent("/repos/r1?tab=files")}`,
    );
  });

  it("never redirects while already on the sign-in screen (no loop)", async () => {
    nav.pathname = "/sign-in";
    window.history.pushState({}, "", "/sign-in?return_to=%2F");
    routeApi({ "/auth/session": unauthenticated, "/a": unauthenticated, "/b": unauthenticated });

    renderApp(<TwoFailingReads />);

    expect(await screen.findByText("both failed")).toBeInTheDocument();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("a 403 forbidden_role toasts and re-reads the session without navigating", async () => {
    nav.pathname = "/settings/api-keys";
    routeApi({
      "/settings": () =>
        json({ error: { code: "forbidden_role", message: "Admins only" } }, 403),
    });

    renderApp(<SaveButton />);
    await waitFor(() => expect(sessionCalls()).toBe(1));

    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    expect(await screen.findByText(authMessages.toasts.forbidden_role)).toBeInTheDocument();
    await waitFor(() => expect(sessionCalls()).toBe(2));
    expect(assignSpy).not.toHaveBeenCalled();
  });
});
