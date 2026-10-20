import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../../../messages/en/prReview.json";
import prHostMessages from "../../../../../messages/en/prHost.json";
import type { PrListPage, PrMetaHost } from "@/lib/types";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ repoId: "r1" }),
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams("status=all"),
  usePathname: () => "/repos/r1/pulls",
}));
vi.mock("@/lib/api", () => ({
  API_BASE: "http://api.test",
  ApiError: class ApiError extends Error {},
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));
// AppShell is the app chrome (AppFrame, command palette, theme, shortcuts, its
// own i18n namespaces + next/link) — out of scope here and mocked like every
// other page test. Everything else (repo context, hooks — incl. the PRRow
// hover reviews read) is REAL, fed by the mocked `@/lib/api` boundary.
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { api } from "@/lib/api";
import { RepoProvider } from "@/lib/repo-context";
import PullsPage from "./page";

/** Minimal EventSource double: records instances, lets the test emit `done`. */
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
}

const row = (n: number, title: string): PrMetaHost =>
  ({
    id: `pr-${n}`,
    number: n,
    title,
    author: "alice",
    branch: "b",
    base: "main",
    head_sha: "sha",
    additions: 1,
    deletions: 1,
    files_count: 1,
    status: "needs_review",
    updated_at: new Date().toISOString(),
  }) as PrMetaHost;

const RUNNING: PrListPage = {
  pulls: [row(1, "Old title")],
  sync: { trigger: "started", state: "running", last_synced_at: null },
};
const DONE: PrListPage = {
  pulls: [row(1, "Old title"), row(2, "Freshly synced PR")],
  sync: { trigger: "fresh", state: "idle", last_synced_at: new Date().toISOString() },
};

const REPOS = [{ id: "r1", full_name: "group/proj" }];
const PAGE_PATH = "/repos/r1/pulls/page";

/** Route GETs by path: `/repos` → the repo list; a PR's run history → `[]`;
 *  the PR page → `pages` in order (last one repeats). */
function mockReads(...pages: PrListPage[]) {
  let i = 0;
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === "/repos") return REPOS;
    if (/^\/pulls\/[^/]+\/reviews$/.test(path)) return [];
    if (path === PAGE_PATH) return pages[Math.min(i++, pages.length - 1)];
    throw new Error(`unexpected GET ${path}`);
  });
}
const pageReads = () => vi.mocked(api.get).mock.calls.filter(([p]) => p === PAGE_PATH).length;

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ prReview: messages, prHost: prHostMessages }}>
        <RepoProvider>
          <PullsPage />
        </RepoProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PullsPage sync", () => {
  it("renders persisted rows while syncing, then updates in place on done (AC-55/59)", async () => {
    mockReads(RUNNING, DONE);
    renderPage();

    expect(await screen.findByText("Old title")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Updating…");
    expect(screen.getByRole("status")).toHaveTextContent("Never synced");

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe("http://api.test/repos/r1/pulls/sync/events");
    act(() => {
      FakeEventSource.instances[0]!.emit("done", { state: "idle", last_synced_at: DONE.sync.last_synced_at });
    });

    expect(await screen.findByText("Freshly synced PR")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Synced just now");
    expect(screen.getByRole("status")).not.toHaveTextContent("Updating…");
    expect(push).not.toHaveBeenCalled();
    expect(pageReads()).toBe(2);
  });

  it("Refresh starts exactly one PR-list sync (plus the clone refresh) and listens for its completion (AC-58)", async () => {
    // While a sync runs, the server answers a list read with `joined/running`.
    const JOINED: PrListPage = {
      pulls: DONE.pulls,
      sync: { ...DONE.sync, trigger: "joined", state: "running" },
    };
    mockReads(DONE, JOINED, DONE);
    vi.mocked(api.post).mockImplementation(async (path: string) =>
      path.endsWith("/pulls/sync") ? { trigger: "started" } : {},
    );
    renderPage();
    await screen.findByText("Freshly synced PR");
    expect(FakeEventSource.instances).toHaveLength(0); // fresh → nothing to wait for (AC-63)

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const syncCalls = vi.mocked(api.post).mock.calls.filter(([p]) => p === "/repos/r1/pulls/sync");
    expect(syncCalls).toHaveLength(1);
    expect(api.post).toHaveBeenCalledWith("/repos/r1/refresh");
    expect(await screen.findByText("Updating…")).toBeInTheDocument();

    act(() => {
      FakeEventSource.instances[0]!.emit("done", { state: "idle", last_synced_at: DONE.sync.last_synced_at });
    });
    await waitFor(() => expect(screen.queryByText("Updating…")).not.toBeInTheDocument());
    expect(FakeEventSource.instances).toHaveLength(1); // no re-subscribe once fresh (AC-63)
  });

  it("manual Refresh keeps Updating… until the sync's done, even if the clone-refresh refetch lands first (AC-58/59)", async () => {
    mockReads(DONE);
    let releaseRefresh: () => void = () => {};
    vi.mocked(api.post).mockImplementation((path: string) =>
      path.endsWith("/pulls/sync")
        ? Promise.resolve({ trigger: "started" })
        : new Promise((resolve) => {
            releaseRefresh = () => resolve({});
          }),
    );
    renderPage();
    await screen.findByText("Freshly synced PR");
    expect(screen.getByRole("status")).not.toHaveTextContent("Updating…");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(screen.getByRole("status")).toHaveTextContent("Updating…");

    // The clone refresh finishes AFTER the sync started and invalidates the list;
    // its refetch (still the old, `fresh` snapshot) must not clear the indicator.
    act(() => releaseRefresh());
    await waitFor(() => expect(pageReads()).toBe(2));
    expect(screen.getByRole("status")).toHaveTextContent("Updating…");

    act(() => {
      FakeEventSource.instances[0]!.emit("done", { state: "idle", last_synced_at: DONE.sync.last_synced_at });
    });
    await waitFor(() => expect(screen.getByRole("status")).not.toHaveTextContent("Updating…"));
    expect(pageReads()).toBe(3);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });

  it("re-clicking Refresh while the manual sync is awaited is a no-op: exactly one POST /pulls/sync (AC-58)", async () => {
    mockReads(DONE);
    let releaseSync: () => void = () => {};
    vi.mocked(api.post).mockImplementation((path: string) =>
      path.endsWith("/pulls/sync")
        ? new Promise((resolve) => {
            releaseSync = () => resolve({ trigger: "started" });
          })
        : Promise.resolve({}),
    );
    renderPage();
    await screen.findByText("Freshly synced PR");
    const syncPosts = () =>
      vi.mocked(api.post).mock.calls.filter(([p]) => p === "/repos/r1/pulls/sync").length;

    const button = screen.getByRole("button", { name: "Refresh" });
    fireEvent.click(button);
    fireEvent.click(button); // POST still pending
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);

    act(() => releaseSync());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    fireEvent.click(button); // sync started, completion not signalled yet
    expect(button).toBeDisabled();
    expect(syncPosts()).toBe(1);
    expect(vi.mocked(api.post).mock.calls.filter(([p]) => p === "/repos/r1/refresh")).toHaveLength(1);
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() => {
      FakeEventSource.instances[0]!.emit("done", { state: "idle", last_synced_at: DONE.sync.last_synced_at });
    });
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("a failed manual sync start is surfaced next to the sync status and Refresh stays usable", async () => {
    mockReads(DONE);
    vi.mocked(api.post).mockImplementation(async (path: string) => {
      if (path.endsWith("/pulls/sync")) throw new Error("boom");
      return {};
    });
    renderPage();
    await screen.findByText("Freshly synced PR");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t start sync");
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(screen.getByRole("status")).not.toHaveTextContent("Updating…");
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
  });
});

describe("PullsPage GitLab token notice (AC-25)", () => {
  const GITLAB_REPOS = [
    {
      id: "r1",
      full_name: "group/proj",
      provider: "gitlab",
      host: "gitlab.com",
      web_url: "https://gitlab.com/group/proj",
    },
  ];
  const FAILED: PrListPage = {
    pulls: [row(1, "Persisted MR")],
    sync: {
      trigger: "fresh",
      state: "failed",
      last_synced_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      last_sync_error: "[gitlab_token_insufficient_scope] missing api scope",
    },
  };

  function mockGitLabReads(health: string | null) {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/repos") return GITLAB_REPOS;
      if (path === "/auth/session")
        return {
          mode: "google",
          user: { id: "u1", email: "m@onlytraf.com", name: "Mem", avatar_url: null, role: "member" },
          workspace: { id: "w1", name: "Team" },
        };
      if (path === "/settings/secrets-status") return { gitlab_health: health };
      if (/^\/pulls\/[^/]+\/reviews$/.test(path)) return [];
      if (path === PAGE_PATH) return FAILED;
      throw new Error(`unexpected GET ${path}`);
    });
  }

  it("insufficient_scope: persistent notice replaces 'showing data from', persisted rows still render", async () => {
    mockGitLabReads("insufficient_scope");
    renderPage();

    expect(await screen.findByText("Persisted MR")).toBeInTheDocument();
    const note = await screen.findByRole("note");
    expect(note).toHaveAttribute("id", "gitlab-token-notice");
    expect(note).toHaveTextContent("The GitLab token is invalid (missing the api scope).");
    expect(await screen.findByText("Ask an admin to update it.")).toBeInTheDocument();
    expect(screen.queryByText(/showing data from/)).not.toBeInTheDocument();
    // The sync age stays.
    expect(screen.getByRole("status")).toHaveTextContent("Synced 2h ago");
  });

  it("ok health: no token notice; the generic sync-failure note is shown (AC-35)", async () => {
    mockGitLabReads("ok");
    renderPage();

    expect(await screen.findByText("Persisted MR")).toBeInTheDocument();
    expect(await screen.findByText(/showing data from/)).toBeInTheDocument();
    expect(screen.queryByText(/The GitLab token is invalid/)).not.toBeInTheDocument();
  });
});
