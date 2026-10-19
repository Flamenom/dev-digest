import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CurrentSession, Role } from "@devdigest/shared";
import messages from "../../../../../messages/en/repos.json";
import authMessages from "../../../../../messages/en/auth.json";
import { ApiError } from "@/lib/api";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const mutateAsync = vi.fn();
vi.mock("@/lib/hooks", () => ({
  useAddRepo: () => ({ mutateAsync, isPending: false }),
}));

import { AddRepoView } from "./AddRepoView";

afterEach(() => {
  cleanup();
  push.mockClear();
  mutateAsync.mockReset();
});

function session(role: Role): CurrentSession {
  return {
    mode: role === "admin" ? "local" : "google",
    user: { id: "u1", email: "a@onlytraf.com", name: "Ann", avatar_url: null, role },
    workspace: { id: "w1", name: "Team" },
  };
}

/** Default: local mode (the seeded user is an Admin) — the UI as before multi-user. */
function renderView(role: Role = "admin") {
  const qc = new QueryClient();
  qc.setQueryData(["session"], session(role));
  render(
    <NextIntlClientProvider locale="en" messages={{ repos: messages, auth: authMessages }}>
      <QueryClientProvider client={qc}>
        <AddRepoView />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

describe("AddRepoView", () => {
  it("advertises github.com and gitlab.com and opens the repo on success", async () => {
    mutateAsync.mockResolvedValue({ id: "r1" });
    renderView();

    expect(screen.getByText(/https:\/\/github\.com\/acme\/payments-api/)).toBeInTheDocument();
    expect(
      screen.getByText(/https:\/\/gitlab\.com\/space-profit\/platform\/crm-frontend/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings → API Keys" })).toHaveAttribute(
      "href",
      "/settings/api-keys",
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://gitlab.com/space-profit/platform/crm-frontend" } });
    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
    expect(mutateAsync).toHaveBeenCalledWith("https://gitlab.com/space-profit/platform/crm-frontend");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/repos/r1/pulls"));
  });

  it("renders a 400 host error inline (4xx is not toasted globally)", async () => {
    mutateAsync.mockRejectedValue(
      new ApiError("unsupported host", 400, "unsupported_repo_host"),
    );
    renderView();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://bitbucket.org/a/b" } });
    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only github.com and gitlab.com repository URLs are supported.",
    );
    expect(push).not.toHaveBeenCalled();

    mutateAsync.mockRejectedValue(new ApiError("Repo already added", 409, "conflict"));
    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
    expect(await screen.findByText("Repo already added")).toBeInTheDocument();
  });

  it("Member: Add repository is aria-disabled with a visible 'Admins only' description and adds nothing", () => {
    renderView("member");

    const add = screen.getByRole("button", { name: "Add repository" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).not.toBeDisabled(); // stays focusable so the reason is reachable
    expect(add).toHaveAccessibleDescription("Admins only");
    expect(screen.getByText("Admins only")).toBeVisible();

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "https://github.com/acme/payments-api" } });
    fireEvent.click(add);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});
