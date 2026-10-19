import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PrListPage } from "../types";

vi.mock("../api", () => ({
  API_BASE: "http://api.test",
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

import { api } from "../api";
import { usePulls, usePullsPage, useSyncPulls } from "./core";

const PAGE: PrListPage = {
  pulls: [
    {
      id: "uuid-1",
      number: 5,
      title: "Add login",
      author: "dev",
      branch: "feat/login",
      base: "main",
      status: "open",
      additions: 0,
      deletions: 0,
      files_count: 0,
      head_sha: "abc",
      updated_at: "2026-10-16T10:00:00Z",
      is_draft: true,
      stats_known: false,
    },
  ],
  sync: { trigger: "fresh", state: "idle", last_synced_at: "2026-10-16T10:00:00Z" },
};

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { wrapper };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.get).mockReset().mockResolvedValue(PAGE);
  vi.mocked(api.post).mockReset().mockResolvedValue({ trigger: "started" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("pulls hooks", () => {
  it("share one ['pulls', repoId] page query with no periodic or focus refetch (AC-63)", async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(
      () => ({ page: usePullsPage("repo-1"), rows: usePulls("repo-1") }),
      { wrapper },
    );
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith("/repos/repo-1/pulls/page");
    expect(result.current.page.data).toEqual(PAGE);
    expect(result.current.rows.data).toEqual(PAGE.pulls);

    // Returning to the tab must not refetch (no focus / visibility refetch).
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.get).toHaveBeenCalledTimes(1);

    // And no periodic refetch while the page stays open.
    await act(() => vi.advanceTimersByTimeAsync(600_000));
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("useSyncPulls posts the manual sync and returns the trigger", async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useSyncPulls(), { wrapper });
    let res: unknown;
    await act(async () => {
      res = await result.current.mutateAsync("repo-1");
    });
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith("/repos/repo-1/pulls/sync");
    expect(res).toEqual({ trigger: "started" });
  });
});
