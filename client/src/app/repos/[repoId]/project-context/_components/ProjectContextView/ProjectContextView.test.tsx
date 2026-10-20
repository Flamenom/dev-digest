import { describe, it, expect, vi } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { DiscoveredDocument, DiscoverySummary } from "@devdigest/shared";
import { apiError, renderWithProviders, testRepo, type RouteRequest, type Routes } from "@/test/render-with-providers";
import { ProjectContextView } from "./ProjectContextView";

vi.mock("next/navigation", () => ({
  usePathname: () => "/repos/r1/project-context",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const DOCUMENTS: DiscoveredDocument[] = [
  { path: "specs/2026-06/project-context.md", bucket: "specs", estimated_tokens: 400, used_by_agents: 1 },
  { path: "docs/adr/one.md", bucket: "docs", estimated_tokens: 300, used_by_agents: 2 },
  { path: "insights/client/INSIGHTS.md", bucket: "insights", estimated_tokens: 250 },
  // Root dir ("server") differs from the bucket ("docs") — badge shows the root dir.
  { path: "server/docs/api.md", bucket: "docs", estimated_tokens: 50, used_by_agents: 0 },
];

const SUMMARY: DiscoverySummary = {
  document_count: 4,
  total_estimated_tokens: 1000,
  refreshed_at: new Date().toISOString(),
  clone_available: true,
};

const TEXTS: Record<string, string> = {
  "specs/2026-06/project-context.md": "# Spec",
  "docs/adr/one.md": "# ADR One\n\nBody of the decision.",
};

function contextApi(extra: Routes = {}): Routes {
  return {
    "GET /repos": [testRepo()],
    "GET /repos/r1/project-context": { documents: DOCUMENTS, summary: SUMMARY },
    "GET /repos/r1/project-context/document": (req: RouteRequest) => {
      const path = req.query.get("path") ?? "";
      return { path, text: TEXTS[path] ?? "" };
    },
    "PUT /repos/r1/project-context/document": (req: RouteRequest) => req.body,
    ...extra,
  };
}

function renderView(session: "admin" | "member" = "admin", extra: Routes = {}) {
  return renderWithProviders(<ProjectContextView repoId="r1" />, {
    session,
    routes: contextApi(extra),
    repoProvider: true,
  });
}

/** Select a document and switch its pane to Edit (once the session resolved to Admin). */
async function openEditor(user: UserEvent, path: string) {
  await user.click(await screen.findByRole("button", { name: `Open ${path}` }));
  const pane = screen.getByRole("region", { name: path });
  const edit = within(pane).getByRole("button", { name: "Edit" });
  await waitFor(() => expect(edit).not.toHaveAttribute("aria-disabled"));
  await user.click(edit);
  return pane;
}

describe("ProjectContextView", () => {
  it("renders the master-detail list with root-dir badges, auto-selects the first document, and shows the summary footer without chunk/index wording", async () => {
    renderView();

    // Left panel: one keyboard-operable row per document.
    expect(
      await screen.findByRole("button", { name: "Open specs/2026-06/project-context.md" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open docs/adr/one.md" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open insights/client/INSIGHTS.md" }),
    ).toBeInTheDocument();

    // Badge = ROOT DIRECTORY of the path (text label — never colour alone, WCAG).
    expect(screen.getByText("specs")).toBeInTheDocument();
    expect(screen.getByText("docs")).toBeInTheDocument();
    expect(screen.getByText("insights")).toBeInTheDocument();
    // server/docs/api.md → "server" (root dir), NOT its bucket "docs".
    const apiRow = screen.getByRole("button", { name: "Open server/docs/api.md" });
    expect(within(apiRow).getByText("server")).toBeInTheDocument();
    expect(within(apiRow).queryByText("docs")).not.toBeInTheDocument();

    // First document auto-selected: its pane renders with "Used by N agents".
    expect(screen.getByRole("region", { name: "specs/2026-06/project-context.md" })).toBeInTheDocument();
    expect(screen.getByText("Used by 1 agent")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Spec" })).toBeInTheDocument();

    // Summary footer: count + summed tokens + refreshed time (AC-7).
    expect(
      screen.getByText(/● 4 documents · ≈ 1000 tokens total · refreshed just now/),
    ).toBeInTheDocument();

    // AC-7: absolutely no chunk/index wording anywhere on the page.
    expect(screen.queryByText(/chunk/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/index/i)).not.toBeInTheDocument();
  });

  it("renders the not-available state (not an error) when the clone is absent (AC-5)", async () => {
    renderView("admin", {
      "GET /repos/r1/project-context": {
        documents: [],
        summary: { ...SUMMARY, document_count: 0, total_estimated_tokens: 0, clone_available: false },
      },
    });

    expect(await screen.findByText("Repo clone not available")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reload button re-reads the discovery (a newly discovered document appears)", async () => {
    const user = userEvent.setup();
    let reads = 0;
    const extraDoc: DiscoveredDocument = { path: "docs/new.md", bucket: "docs", estimated_tokens: 10 };
    renderView("admin", {
      "GET /repos/r1/project-context": () => {
        reads += 1;
        return { documents: reads > 1 ? [...DOCUMENTS, extraDoc] : DOCUMENTS, summary: SUMMARY };
      },
    });

    await user.click(await screen.findByRole("button", { name: "Reload documents" }));
    expect(await screen.findByRole("button", { name: "Open docs/new.md" })).toBeInTheDocument();
  });

  it("selects a document, toggles inline Preview/Edit, shows the resync warning, and saves (AC-31..AC-34)", async () => {
    const user = userEvent.setup();
    const { router } = renderView();

    // Select a document in the left list — the right pane shows it inline (no drawer).
    await user.click(await screen.findByRole("button", { name: "Open docs/adr/one.md" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const pane = screen.getByRole("region", { name: "docs/adr/one.md" });
    expect(within(pane).getByText("one.md")).toBeInTheDocument();
    expect(within(pane).getByText("Used by 2 agents")).toBeInTheDocument();

    // Preview tab is active by default and renders the markdown.
    expect(within(pane).getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("heading", { name: "ADR One" })).toBeInTheDocument();

    // Switch to Edit: keyboard-operable textarea with the raw markdown (AC-31).
    await openEditor(user, "docs/adr/one.md");
    expect(within(pane).getByRole("button", { name: "Edit" })).toHaveAttribute("aria-pressed", "true");
    const textarea = screen.getByLabelText("Raw markdown");
    expect(textarea).toHaveValue("# ADR One\n\nBody of the decision.");

    // Resync-clobber warning is surfaced (AC-34).
    expect(screen.getByText(/git reset --hard/)).toBeInTheDocument();

    // Edit + Save writes { path, text } and confirms inline.
    await user.clear(textarea);
    await user.type(textarea, "# ADR One (edited)");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved to the repo clone.")).toBeInTheDocument();
    expect(router.calls.find((c) => c.method === "PUT")?.body).toEqual({
      path: "docs/adr/one.md",
      text: "# ADR One (edited)",
    });
  });

  it("a failed save is reported inline only — no global toast on top", async () => {
    const user = userEvent.setup();
    renderView("admin", {
      "PUT /repos/r1/project-context/document": () => apiError(500, "internal", "disk exploded"),
    });
    await openEditor(user, "docs/adr/one.md");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Save failed — the document was not written.")).toBeInTheDocument();
    expect(screen.queryByText("disk exploded")).not.toBeInTheDocument();
  });
});

describe("ProjectContextView gating (AC-33)", () => {
  it("Member: read-only Preview — Edit is aria-disabled with an 'Admins only' hint and never opens the editor", async () => {
    const user = userEvent.setup();
    renderView("member");

    const pane = await screen.findByRole("region", { name: "specs/2026-06/project-context.md" });
    const edit = within(pane).getByRole("button", { name: "Edit" });
    await waitFor(() => expect(edit).toHaveAccessibleDescription("Admins only"));
    expect(edit).toHaveAttribute("aria-disabled", "true");
    await user.click(edit);
    expect(edit).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByLabelText("Raw markdown")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Spec" })).toBeInTheDocument();
  });

  it("Admin: Edit is enabled with no hint", async () => {
    renderView();
    const edit = await screen.findByRole("button", { name: "Edit" });
    await waitFor(() => expect(edit).not.toHaveAttribute("aria-disabled"));
    expect(screen.queryByText("Admins only")).not.toBeInTheDocument();
  });
});
