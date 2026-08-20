import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ConventionListResponse } from "@devdigest/shared";
import messages from "../../../../../messages/en/conventions.json";

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock("@/lib/repo-context", () => ({
  useActiveRepo: () => ({
    repoId: "r1",
    activeRepo: { id: "r1", full_name: "acme/payments-api" },
    repos: [],
    reposLoaded: true,
    setRepoId: vi.fn(),
  }),
}));

const extractMutate = vi.fn();
const bulkMutate = vi.fn();
let queryState: {
  data?: ConventionListResponse;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
};
vi.mock("@/lib/hooks/conventions", () => ({
  useConventions: () => queryState,
  useExtractConventions: () => ({ mutate: extractMutate, isPending: false }),
  useBulkConventionStatus: () => ({ mutate: bulkMutate, isPending: false }),
  useUpdateConvention: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { ConventionsView } from "./ConventionsView";

afterEach(() => {
  cleanup();
  extractMutate.mockClear();
  bulkMutate.mockClear();
});

const POPULATED: ConventionListResponse = {
  conventions: [
    {
      id: "c1",
      repo_id: "r1",
      category: "error-handling",
      rule: "Always use async/await instead of .then() chains",
      evidence_path: "src/api/users.ts",
      evidence_snippet: "const user = await db.users.find(id);",
      evidence_start_line: 23,
      evidence_end_line: 31,
      confidence: 0.91,
      status: "accepted",
      created_at: "2026-08-19T00:00:00Z",
    },
    {
      id: "c2",
      repo_id: "r1",
      category: "structure",
      rule: "Redis access goes through the singleton",
      evidence_path: "src/lib/redis.ts",
      evidence_snippet: "export const redis = new Redis(config.redisUrl);",
      evidence_start_line: 1,
      evidence_end_line: 1,
      confidence: 0.85,
      status: "pending",
      created_at: "2026-08-19T00:00:00Z",
    },
  ],
  stats: { sampledFileCount: 84, droppedCount: 2, lastScanAt: new Date().toISOString() },
};

function renderView() {
  render(
    <NextIntlClientProvider locale="en" messages={{ conventions: messages }}>
      <ConventionsView />
    </NextIntlClientProvider>,
  );
}

describe("ConventionsView", () => {
  it("empty state: Run extraction CTA triggers the extract mutation", () => {
    queryState = {
      data: { conventions: [], stats: null },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    renderView();
    expect(screen.getByText("No conventions extracted yet")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Run extraction"));
    expect(extractMutate).toHaveBeenCalledTimes(1);
  });

  it("populated: heading, scan meta, accepted count, cards; Deselect all resets to pending", () => {
    queryState = { data: POPULATED, isLoading: false, isError: false, refetch: vi.fn() };
    renderView();
    expect(screen.getByText("acme/payments-api")).toBeInTheDocument();
    expect(screen.getByText(/Detected from 84 sample files/)).toBeInTheDocument();
    expect(screen.getByText(/2 ungrounded candidates dropped/)).toBeInTheDocument();
    expect(screen.getByText("1 of 2 accepted")).toBeInTheDocument();
    expect(screen.getByText("Redis access goes through the singleton")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Deselect all"));
    expect(bulkMutate).toHaveBeenCalledWith("pending");
    fireEvent.click(screen.getByText("Re-scan"));
    expect(extractMutate).toHaveBeenCalled();
  });

  it("error state renders the load error with retry", () => {
    const refetch = vi.fn();
    queryState = { isLoading: false, isError: true, refetch };
    renderView();
    expect(screen.getByText("Could not load conventions.")).toBeInTheDocument();
  });
});
