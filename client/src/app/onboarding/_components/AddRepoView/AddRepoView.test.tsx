import { describe, it, expect, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderWithProviders, testRepo, type Routes } from "@/test/render-with-providers";
import { AddRepoView } from "./AddRepoView";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(() => push.mockClear());

function renderView(session: "admin" | "member" = "admin", routes: Routes = {}) {
  return renderWithProviders(<AddRepoView />, { session, routes });
}

/** The Add button once the session resolved to Admin (live). */
async function findLiveAdd() {
  const add = await screen.findByRole("button", { name: "Add repository" });
  await waitFor(() => expect(add).not.toHaveAttribute("aria-disabled"));
  return add;
}

describe("AddRepoView", () => {
  it("advertises github.com and gitlab.com and opens the repo on success", async () => {
    const user = userEvent.setup();
    const { router } = renderView("admin", { "POST /repos": testRepo({ id: "r1" }) });

    expect(screen.getByText(/https:\/\/github\.com\/acme\/payments-api/)).toBeInTheDocument();
    expect(
      screen.getByText(/https:\/\/gitlab\.com\/space-profit\/platform\/crm-frontend/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings → API Keys" })).toHaveAttribute(
      "href",
      "/settings/api-keys",
    );

    const add = await findLiveAdd();
    await user.type(screen.getByRole("textbox"), "https://gitlab.com/space-profit/platform/crm-frontend");
    await user.click(add);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/repos/r1/pulls"));
    expect(router.calls.find((c) => c.method === "POST")?.body).toEqual({
      url: "https://gitlab.com/space-profit/platform/crm-frontend",
    });
  });

  it("renders add failures inline only — no global toast on top", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    renderView("admin", {
      "POST /repos": () =>
        ++attempt === 1
          ? apiError(400, "unsupported_repo_host", "unsupported host")
          : apiError(409, "conflict", "Repo already added"),
    });

    const add = await findLiveAdd();
    await user.type(screen.getByRole("textbox"), "https://bitbucket.org/a/b");
    await user.click(add);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only github.com and gitlab.com repository URLs are supported.",
    );
    expect(screen.queryByText("unsupported host")).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();

    await user.click(add);
    // Exactly one place shows the message: the inline alert (getBy throws on duplicates).
    expect(await screen.findByText("Repo already added")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Repo already added");
  });

  it("Member: Add repository is aria-disabled with a visible 'Admins only' description and adds nothing", async () => {
    const user = userEvent.setup();
    const { router } = renderView("member");

    const add = await screen.findByRole("button", { name: "Add repository", description: "Admins only" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).not.toBeDisabled(); // stays focusable so the reason is reachable
    expect(screen.getByText("Admins only")).toBeVisible();

    const input = screen.getByRole("textbox");
    await user.type(input, "https://github.com/acme/payments-api");
    await user.click(add);
    await user.type(input, "{Enter}");
    // Sync point: keep typing (allowed for a Member) and wait for it to land —
    // any POST the click/Enter had started is recorded, and its alert or
    // navigation rendered, by then.
    await user.type(input, "-v2");
    expect(await screen.findByDisplayValue("https://github.com/acme/payments-api-v2")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    expect(router.calls.some((c) => c.method === "POST")).toBe(false);
  });
});
