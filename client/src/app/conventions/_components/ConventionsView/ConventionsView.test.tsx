import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import type { Convention, ConventionListResponse } from "@devdigest/shared";
import { apiError, renderWithProviders, testRepo, type RouteRequest, type Routes } from "@/test/render-with-providers";
import { ConventionsView } from "./ConventionsView";

vi.mock("next/navigation", () => ({
  usePathname: () => "/conventions",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

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

/** In-memory conventions API for repo r1 (extract returns POPULATED; bulk PATCH resets status). */
function conventionsApi(initial: ConventionListResponse, extra: Routes = {}): Routes {
  let list = initial;
  return {
    "GET /repos": [testRepo()],
    "GET /repos/r1/conventions": () => list,
    "POST /repos/r1/conventions/extract": () => {
      list = POPULATED;
      return list;
    },
    "PATCH /repos/r1/conventions": (req: RouteRequest) => {
      const { status } = req.body as { status: Convention["status"] };
      list = { ...list, conventions: list.conventions.map((c) => ({ ...c, status })) };
      return { updated: list.conventions.length };
    },
    ...extra,
  };
}

const EMPTY: ConventionListResponse = { conventions: [], stats: null };

function renderView(list: ConventionListResponse, session: "admin" | "member" = "admin", extra: Routes = {}) {
  return renderWithProviders(<ConventionsView />, {
    session,
    routes: conventionsApi(list, extra),
    repoProvider: true,
  });
}

/** Wait until the session resolved to Admin (gated controls live). */
async function findLive(name: RegExp) {
  const btn = await screen.findByRole("button", { name });
  await waitFor(() => expect(btn).not.toHaveAttribute("aria-disabled"));
  return btn;
}

describe("ConventionsView", () => {
  it("empty state: Run extraction scans and shows the extracted conventions", async () => {
    renderView(EMPTY);
    expect(await screen.findByText("No conventions extracted yet")).toBeInTheDocument();
    fireEvent.click(await findLive(/Run extraction/));
    expect(await screen.findByText("Redis access goes through the singleton")).toBeInTheDocument();
  });

  it("populated: heading, scan meta, accepted count, cards; Deselect all resets to pending", async () => {
    renderView(POPULATED);
    expect(await screen.findByText("acme/payments-api")).toBeInTheDocument();
    expect(await screen.findByText(/Detected from 84 sample files/)).toBeInTheDocument();
    expect(screen.getByText(/2 ungrounded candidates dropped/)).toBeInTheDocument();
    expect(screen.getByText("1 of 2 accepted")).toBeInTheDocument();
    expect(screen.getByText("Redis access goes through the singleton")).toBeInTheDocument();

    fireEvent.click(await findLive(/Deselect all/));
    expect(await screen.findByText("0 of 2 accepted")).toBeInTheDocument();
  });

  it("a failed extraction raises exactly one toast — the view's own message, not the generic one", async () => {
    renderView(EMPTY, "admin", {
      "POST /repos/r1/conventions/extract": () => apiError(500, "internal", "boom from the API"),
    });
    fireEvent.click(await findLive(/Run extraction/));
    expect(await screen.findByText("Extraction failed")).toBeInTheDocument();
    expect(screen.queryByText("boom from the API")).not.toBeInTheDocument();
  });

  it("error state renders the load error", async () => {
    renderView(EMPTY, "admin", { "GET /repos/r1/conventions": () => apiError(404, "not_found") });
    expect(await screen.findByText("Could not load conventions.")).toBeInTheDocument();
  });
});

describe("ConventionsView gating (AC-33)", () => {
  it("Member: Run extraction is aria-disabled with an 'Admins only' hint and does not extract", async () => {
    const { router } = renderView(EMPTY, "member");
    const run = await screen.findByRole("button", { name: /Run extraction/, description: "Admins only" });
    expect(run).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(run);
    expect(screen.getByText("No conventions extracted yet")).toBeInTheDocument();
    expect(router.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("Member: Re-scan, Deselect all and Create skill are aria-disabled and inert; the list stays readable", async () => {
    const { router } = renderView(POPULATED, "member");
    await screen.findByRole("button", { name: /Re-scan/, description: "Admins only" });
    for (const name of [/Re-scan/, /Deselect all/, /Create skill/]) {
      const btn = screen.getByRole("button", { name });
      expect(btn).toHaveAttribute("aria-disabled", "true");
      expect(btn).toHaveAccessibleDescription("Admins only");
      fireEvent.click(btn);
    }
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 2 accepted")).toBeInTheDocument();
    expect(screen.getByText("Redis access goes through the singleton")).toBeInTheDocument();
    expect(router.calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("Admin: the same controls are enabled with no hint", async () => {
    renderView(POPULATED);
    for (const name of [/Re-scan/, /Deselect all/, /Create skill/]) await findLive(name);
    expect(screen.queryByText("Admins only")).not.toBeInTheDocument();
  });
});
