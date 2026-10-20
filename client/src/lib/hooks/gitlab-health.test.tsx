import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SecretsStatusWithHealth } from "../types";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    API_BASE: "http://api.test",
    ApiError: actual.ApiError,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

import { api, ApiError } from "../api";
import { useGitLabTokenHealth } from "./gitlab-health";
import { useCreatePrComment } from "./reviews";
import { useTestConnection } from "./core";

function status(gitlab_health: SecretsStatusWithHealth["gitlab_health"]): SecretsStatusWithHealth {
  return {
    openai: false,
    anthropic: false,
    openrouter: false,
    github: false,
    gitlab: gitlab_health != null,
    gitlab_health,
  } as SecretsStatusWithHealth;
}

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

beforeEach(() => {
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
});
afterEach(() => cleanup());

describe("useGitLabTokenHealth", () => {
  it("is blocked for a known-bad token and not blocked when no token is configured", async () => {
    vi.mocked(api.get).mockResolvedValue(status("insufficient_scope"));
    const bad = renderHook(() => useGitLabTokenHealth(), { wrapper: makeWrapper().wrapper });
    await waitFor(() => expect(bad.result.current.health).toBe("insufficient_scope"));
    expect(bad.result.current.blocked).toBe(true);
    expect(api.get).toHaveBeenCalledWith("/settings/secrets-status");

    vi.mocked(api.get).mockResolvedValue(status("invalid"));
    const invalid = renderHook(() => useGitLabTokenHealth(), { wrapper: makeWrapper().wrapper });
    await waitFor(() => expect(invalid.result.current.health).toBe("invalid"));
    expect(invalid.result.current.blocked).toBe(true);

    vi.mocked(api.get).mockResolvedValue(status(null));
    const none = renderHook(() => useGitLabTokenHealth(), { wrapper: makeWrapper().wrapper });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(none.result.current).toEqual({ health: null, blocked: false }));
  });

  it("treats ok and unchecked as usable", async () => {
    vi.mocked(api.get).mockResolvedValue(status("unchecked"));
    const { result } = renderHook(() => useGitLabTokenHealth(), { wrapper: makeWrapper().wrapper });
    await waitFor(() => expect(result.current.health).toBe("unchecked"));
    expect(result.current.blocked).toBe(false);
  });
});

describe("GitLab token health refresh after a write", () => {
  it("a comment rejected for a bad GitLab token refreshes secrets-status; other failures don't", async () => {
    const { qc, wrapper } = makeWrapper();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useCreatePrComment("pr-1"), { wrapper });

    vi.mocked(api.post).mockRejectedValueOnce(
      new ApiError("missing api scope", 403, "gitlab_token_insufficient_scope"),
    );
    await act(async () => {
      await expect(
        result.current.mutateAsync({ path: "a.ts", line: 1, body: "hi" }),
      ).rejects.toBeInstanceOf(ApiError);
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["secrets-status"] });

    invalidate.mockClear();
    vi.mocked(api.post).mockRejectedValueOnce(
      new ApiError("outdated", 409, "comment_diff_outdated"),
    );
    await act(async () => {
      await expect(
        result.current.mutateAsync({ path: "a.ts", line: 1, body: "hi" }),
      ).rejects.toBeInstanceOf(ApiError);
    });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["secrets-status"] });
  });

  it("a failed GitLab connection test still refreshes secrets-status", async () => {
    const { qc, wrapper } = makeWrapper();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    vi.mocked(api.post).mockResolvedValueOnce({
      ok: false,
      code: "gitlab_token_insufficient_scope",
      message: "missing api scope",
    });
    const { result } = renderHook(() => useTestConnection(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ provider: "gitlab", key: "glpat-x" });
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["secrets-status"] });
  });
});
