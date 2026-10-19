import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { PrFileHost } from "@/lib/types";
import prReview from "../../../../../../../../messages/en/prReview.json";
import shell from "../../../../../../../../messages/en/shell.json";
import prHost from "../../../../../../../../messages/en/prHost.json";

// Same hook-module mocking as DiffTab.test.tsx — no QueryClient / fetch.
vi.mock("@/lib/hooks/reviews", () => ({
  usePrComments: () => ({ data: [] }),
  useCreatePrComment: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/hooks/smart-diff", () => ({
  usePrSmartDiff: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
}));

import { DiffTab } from "./DiffTab";

afterEach(cleanup);

const NOTE = "Posting comments to GitLab isn't supported yet — copy the text instead.";

const FILES: PrFileHost[] = [
  {
    path: "src/new-name.ts",
    previous_path: "src/old-name.ts",
    change_type: "renamed",
    additions: 1,
    deletions: 0,
    patch: "@@ -1,1 +1,2 @@\n a\n+b",
  },
  { path: "dist/bundle.js", additions: 9000, deletions: 0, patch: null, patch_omitted: "too_large" },
];

function renderTab(readOnly: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ prReview, shell, prHost }}>
      <DiffTab
        prId="pr1"
        filesCount={FILES.length}
        files={FILES}
        canComment
        readOnly={readOnly}
        provider={readOnly ? "gitlab" : "github"}
        filesOmittedByHost={readOnly ? 1 : 0}
      />
    </NextIntlClientProvider>,
  );
}

describe("DiffTab on a read-only host (GitLab)", () => {
  it("shows a disabled post control explained by a visible note, plus the omitted-files count", () => {
    renderTab(true);

    const post = screen.getByRole("button", { name: "Post comment" });
    expect(post).toBeDisabled();
    expect(post).toHaveAccessibleDescription(NOTE);
    expect(screen.getByText(NOTE)).toBeVisible();
    expect(screen.getByText("1 file not reviewed (diff unavailable)")).toBeInTheDocument();
  });

  it("the inline composer drafts but cannot post; its text can be copied", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderTab(true);
    fireEvent.click(screen.getByRole("button", { name: "Original order" }));

    const row = document.querySelector('[data-line-no="2"]') as HTMLElement;
    fireEvent.mouseEnter(row);
    fireEvent.click(screen.getByRole("button", { name: "Add a comment on this line" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Consider renaming back" } });

    const post = screen.getByRole("button", { name: "Comment" });
    expect(post).toBeDisabled();
    expect(post).toHaveAccessibleDescription(NOTE);
    fireEvent.click(screen.getByRole("button", { name: "Copy text" }));
    expect(writeText).toHaveBeenCalledWith("Consider renaming back");
  });

  it("GitHub keeps commenting enabled with no read-only notice", () => {
    renderTab(false);
    expect(screen.queryByRole("button", { name: "Post comment" })).not.toBeInTheDocument();
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
    expect(screen.queryByText(/not reviewed/)).not.toBeInTheDocument();
  });
});
