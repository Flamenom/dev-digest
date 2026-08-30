import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { DiscoveredDocument, DiscoverySummary, DocumentContent } from "@devdigest/shared";
import messages from "../../../../../../../messages/en/projectContext.json";

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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

const saveMutate = vi.fn();
let queryState: {
  data?: { documents: DiscoveredDocument[]; summary: DiscoverySummary };
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
};
let docState: {
  data?: DocumentContent;
  isLoading: boolean;
  isError: boolean;
};
vi.mock("@/lib/hooks/projectContext", () => ({
  useProjectContext: () => queryState,
  useDocument: () => docState,
  useSaveDocument: () => ({
    mutate: saveMutate,
    isPending: false,
    isSuccess: false,
    isError: false,
  }),
}));

import { ProjectContextView } from "./ProjectContextView";

afterEach(() => {
  cleanup();
  saveMutate.mockClear();
});

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

function renderView() {
  render(
    <NextIntlClientProvider locale="en" messages={{ projectContext: messages }}>
      <ProjectContextView repoId="r1" />
    </NextIntlClientProvider>,
  );
}

describe("ProjectContextView", () => {
  it("renders the master-detail list with root-dir badges, auto-selects the first document, and shows the summary footer without chunk/index wording", () => {
    queryState = {
      data: { documents: DOCUMENTS, summary: SUMMARY },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    docState = {
      data: { path: "specs/2026-06/project-context.md", text: "# Spec" },
      isLoading: false,
      isError: false,
    };
    renderView();

    // Left panel: one keyboard-operable row per document.
    expect(
      screen.getByRole("button", { name: "Open specs/2026-06/project-context.md" }),
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

    // Summary footer: count + summed tokens + refreshed time (AC-7).
    expect(
      screen.getByText(/● 4 documents · ≈ 1000 tokens total · refreshed just now/),
    ).toBeInTheDocument();

    // AC-7: absolutely no chunk/index wording anywhere on the page.
    expect(screen.queryByText(/chunk/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/index/i)).not.toBeInTheDocument();
  });

  it("renders the not-available state (not an error) when the clone is absent (AC-5)", () => {
    queryState = {
      data: {
        documents: [],
        summary: { ...SUMMARY, document_count: 0, total_estimated_tokens: 0, clone_available: false },
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    docState = { isLoading: false, isError: false };
    renderView();

    expect(screen.getByText("Repo clone not available")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reload button refetches the discovery query", () => {
    const refetch = vi.fn();
    queryState = {
      data: { documents: DOCUMENTS, summary: SUMMARY },
      isLoading: false,
      isError: false,
      refetch,
    };
    docState = { isLoading: false, isError: false };
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "Reload documents" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("selects a document, toggles inline Preview/Edit, shows the resync warning, and saves via the mutation (AC-31..AC-34)", () => {
    queryState = {
      data: { documents: DOCUMENTS, summary: SUMMARY },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    docState = {
      data: { path: "docs/adr/one.md", text: "# ADR One\n\nBody of the decision." },
      isLoading: false,
      isError: false,
    };
    renderView();

    // Select a document in the left list — the right pane shows it inline (no drawer).
    fireEvent.click(screen.getByRole("button", { name: "Open docs/adr/one.md" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const pane = screen.getByRole("region", { name: "docs/adr/one.md" });
    expect(within(pane).getByText("one.md")).toBeInTheDocument();
    expect(within(pane).getByText("Used by 2 agents")).toBeInTheDocument();

    // Preview tab is active by default and renders the markdown.
    expect(within(pane).getByRole("button", { name: "Preview" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("heading", { name: "ADR One" })).toBeInTheDocument();

    // Switch to Edit: keyboard-operable textarea with the raw markdown (AC-31).
    fireEvent.click(within(pane).getByRole("button", { name: "Edit" }));
    expect(within(pane).getByRole("button", { name: "Edit" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const textarea = screen.getByLabelText("Raw markdown");
    expect(textarea).toHaveValue("# ADR One\n\nBody of the decision.");

    // Resync-clobber warning is surfaced (AC-34).
    expect(screen.getByText(/git reset --hard/)).toBeInTheDocument();

    // Edit + Save calls the save mutation with { path, text }.
    fireEvent.change(textarea, { target: { value: "# ADR One (edited)" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(saveMutate).toHaveBeenCalledWith({
      path: "docs/adr/one.md",
      text: "# ADR One (edited)",
    });
  });
});
