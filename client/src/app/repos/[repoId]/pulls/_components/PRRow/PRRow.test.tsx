import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../../../../../messages/en/prReview.json";
import type { PrMetaHost } from "@/lib/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/hooks/reviews", () => ({
  usePrReviews: () => ({ data: [], isLoading: false }),
}));

import { PRRow } from "./PRRow";

afterEach(cleanup);

const BASE: PrMetaHost = {
  id: "pr-1",
  number: 7,
  title: "Add GitLab sync",
  author: "alice",
  branch: "feat/x",
  base: "main",
  head_sha: "abc",
  additions: 10,
  deletions: 2,
  files_count: 3,
  status: "needs_review",
  updated_at: new Date().toISOString(),
} as PrMetaHost;

function renderRow(pr: PrMetaHost) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ prReview: messages }}>
      <PRRow pr={pr} repoId="r1" />
    </NextIntlClientProvider>,
  );
}

describe("PRRow", () => {
  it("marks a draft pull request and shows known stats as a size bucket", () => {
    renderRow({ ...BASE, is_draft: true });
    expect(screen.getByText("Add GitLab sync")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("S · 12")).toBeInTheDocument();
    expect(screen.queryByLabelText("Diff stats not available yet")).not.toBeInTheDocument();
  });

  it("shows — instead of 0 when the host did not report stats, and no draft badge for a ready PR", () => {
    renderRow({ ...BASE, additions: 0, deletions: 0, stats_known: false });
    const unknown = screen.getByLabelText("Diff stats not available yet");
    expect(unknown).toHaveTextContent("—");
    expect(screen.queryByText(/S · 0/)).not.toBeInTheDocument();
    expect(screen.queryByText("Draft")).not.toBeInTheDocument();
    expect(within(unknown).queryByText("0")).not.toBeInTheDocument();
  });
});
