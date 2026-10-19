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
import { usePullsSync } from "./pr-sync";

/** Minimal EventSource double: records instances, lets the test emit events. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onerror: ((ev: Event) => void) | null = null;
  private listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    if (this.closed) return;
    const ev = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  fail() {
    this.onerror?.(new Event("error"));
  }
}

const RUNNING: PrListPage = {
  pulls: [],
  sync: { trigger: "started", state: "running", last_synced_at: null },
};
const JOINED: PrListPage = {
  pulls: [],
  sync: { trigger: "joined", state: "running", last_synced_at: "2026-10-16T10:00:00Z" },
};
const FRESH: PrListPage = {
  pulls: [],
  sync: { trigger: "fresh", state: "idle", last_synced_at: "2026-10-16T10:05:00Z" },
};

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => usePullsSync("repo-1"), { wrapper });
}

/** Let pending promises/effects flush, moving the clock so each read gets a new timestamp. */
const tick = (ms = 1_000) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("usePullsSync", () => {
  it("one done → closes the stream, refetches the list exactly once, then stays silent (AC-59/63)", async () => {
    vi.mocked(api.get).mockResolvedValueOnce(RUNNING).mockResolvedValue(FRESH);
    const { result } = setup();
    await tick();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenLastCalledWith("/repos/repo-1/pulls/page");
    expect(result.current.updating).toBe(true);

    expect(FakeEventSource.instances).toHaveLength(1);
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe("http://api.test/repos/repo-1/pulls/sync/events");

    await act(async () => {
      es.emit("done", { state: "idle", last_synced_at: FRESH.sync.last_synced_at });
      es.emit("done", { state: "idle", last_synced_at: FRESH.sync.last_synced_at });
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(es.closed).toBe(true);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(result.current.updating).toBe(false);

    await tick(600_000);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("a done whose refetch still reports an in-flight sync opens ONE new listener; its done clears Updating", async () => {
    vi.mocked(api.get)
      .mockResolvedValueOnce(RUNNING)
      .mockResolvedValueOnce(JOINED)
      .mockResolvedValue(FRESH);
    const { result } = setup();
    await tick();
    expect(FakeEventSource.instances).toHaveLength(1);

    await act(async () => {
      FakeEventSource.instances[0]!.emit("done", {});
      await vi.advanceTimersByTimeAsync(1_000);
    });
    // The refetch still says `joined/running` → a fresh one-shot listener for that read.
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(result.current.updating).toBe(true);

    await act(async () => {
      FakeEventSource.instances[1]!.emit("done", {});
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(FakeEventSource.instances[1]!.closed).toBe(true);
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(result.current.updating).toBe(false);

    await tick(600_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(api.get).toHaveBeenCalledTimes(3);
  });

  it("error → closes without retry and refetches once; a still-running read neither re-subscribes nor sticks on Updating; Refresh resumes; unmount closes", async () => {
    vi.mocked(api.get).mockResolvedValueOnce(RUNNING).mockResolvedValue(JOINED);
    vi.mocked(api.post).mockResolvedValue({ trigger: "joined" });
    const { result, unmount } = setup();
    await tick();
    const es = FakeEventSource.instances[0]!;
    await act(async () => {
      es.fail();
      es.fail();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(es.closed).toBe(true);
    // Exactly one extra list fetch so the list re-reads its persisted sync status…
    expect(api.get).toHaveBeenCalledTimes(2);
    // …which still says `joined/running`, but nothing listens any more — so the
    // indicator must not stay stuck on Updating….
    expect(result.current.sync?.state).toBe("running");
    expect(result.current.updating).toBe(false);
    // …and no error → refetch → listen → error loop (AC-63).
    await tick(600_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(result.current.updating).toBe(false);

    // A manual Refresh un-suspends: one POST, one new listener, Updating… again.
    await act(async () => {
      result.current.onRefresh();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(vi.mocked(api.post).mock.calls.filter(([p]) => p === "/repos/repo-1/pulls/sync")).toHaveLength(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(result.current.updating).toBe(true);

    unmount();
    expect(es.closed).toBe(true);
    expect(FakeEventSource.instances[1]!.closed).toBe(true);
  });

  it("idle (fresh) list: zero extra requests and zero EventSources over 10 minutes (AC-63)", async () => {
    vi.mocked(api.get).mockResolvedValue(FRESH);
    const { result } = setup();
    await tick();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(result.current.updating).toBe(false);

    await tick(600_000);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.post).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
