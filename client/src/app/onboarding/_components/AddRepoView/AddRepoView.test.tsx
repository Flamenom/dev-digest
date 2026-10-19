import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../../../messages/en/repos.json";
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

function renderView() {
  render(
    <NextIntlClientProvider locale="en" messages={{ repos: messages }}>
      <AddRepoView />
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
});
