import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api, apiFetch, ApiError, API_BASE } from "./api";

/* apiFetch is the ONLY fetch in the app — every hook builds on it, and the
   error-UX taxonomy (toast / inline / full-screen) branches on the ApiError
   it normalizes to. These tests pin that contract. */

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? "",
    headers: { "content-type": "application/json" },
  });
}

describe("apiFetch", () => {
  it("returns the parsed JSON body on success", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "r1" }));
    await expect(apiFetch<{ id: string }>("/repos/r1")).resolves.toEqual({ id: "r1" });
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/repos/r1`, expect.anything());
  });

  it("returns undefined for a 204 No Content", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(apiFetch("/runs/x")).resolves.toBeUndefined();
  });

  it("only sends a JSON content-type when a body is present (empty POST must not trip Fastify)", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));
    await api.post("/repos/r1/refresh");
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["content-type"]).toBeUndefined();

    await api.post("/repos", { url: "https://github.com/a/b" });
    const headers2 = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(headers2["content-type"]).toBe("application/json");
  });

  it("unwraps the API error envelope into ApiError fields", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: "not_found", message: "Repo not found", details: { id: "x" } } },
        { status: 404, statusText: "Not Found" },
      ),
    );
    const err = await apiFetch("/repos/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: "not_found", message: "Repo not found" });
  });

  it("falls back to status text when the error body is not JSON", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>oops</html>", { status: 502, statusText: "Bad Gateway" }),
    );
    const err = await apiFetch("/repos").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 502, message: "502 Bad Gateway", code: undefined });
  });

  it("normalizes a network failure to ApiError status 0 (full-screen error candidate)", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const err = await apiFetch("/repos").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: "network_error" });
    expect((err as ApiError).message).toContain("Is the API running?");
  });
});

describe("api verb helpers", () => {
  it.each([
    ["get", () => api.get("/x"), "GET"],
    ["put", () => api.put("/x", { a: 1 }), "PUT"],
    ["patch", () => api.patch("/x", { a: 1 }), "PATCH"],
    ["del", () => api.del("/x"), "DELETE"],
  ] as const)("api.%s uses the right method", async (_name, call, method) => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await call();
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    // apiFetch passes GET implicitly (no method key) — normalize for the assert.
    expect(init.method ?? "GET").toBe(method);
  });
});
