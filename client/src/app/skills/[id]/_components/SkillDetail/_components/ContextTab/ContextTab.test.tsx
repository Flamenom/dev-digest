import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from "vitest";
import { render, screen, within, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DiscoveredDocument, DiscoverySummary, Repo, Skill } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/skills.json";

// ContextTab talks to the API through lib/api only — mock it wholesale.
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

import { api } from "@/lib/api";
import { ContextTab } from "./ContextTab";

afterEach(cleanup);

const REPO: Repo = {
  id: "r1",
  workspace_id: "ws1",
  owner: "acme",
  name: "api",
  full_name: "acme/api",
  default_branch: "main",
  clone_path: "/clones/acme/api",
  last_polled_at: null,
  created_by: null,
};

const DOCS: DiscoveredDocument[] = [
  { path: "specs/auth.md", bucket: "specs", estimated_tokens: 120 },
  { path: "docs/guide/setup.md", bucket: "docs", estimated_tokens: 80 },
  { path: "insights/perf.md", bucket: "insights", estimated_tokens: 40 },
  // Root dir ("server") differs from the bucket ("docs") — badge shows the root dir.
  { path: "server/notes/arch.md", bucket: "docs", estimated_tokens: 60 },
];

const SUMMARY: DiscoverySummary = {
  document_count: 4,
  total_estimated_tokens: 300,
  refreshed_at: "2026-08-27T00:00:00.000Z",
  clone_available: true,
};

// Attached (ordered): setup first, then auth.
const SKILL: Skill = {
  id: "sk1",
  name: "arch-invariants",
  description: "Architecture invariants",
  type: "convention",
  source: "manual",
  body: "- rule",
  enabled: true,
  version: 1,
  attached_doc_paths: ["docs/guide/setup.md", "specs/auth.md"],
};

beforeEach(() => {
  vi.clearAllMocks();
  (api.get as Mock).mockImplementation((path: string) => {
    if (path === "/repos") return Promise.resolve([REPO]);
    if (path === "/repos/r1/project-context")
      return Promise.resolve({ documents: DOCS, summary: SUMMARY });
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  (api.put as Mock).mockImplementation((_path: string, body: { paths: string[] }) =>
    Promise.resolve({ ...SKILL, attached_doc_paths: body.paths }),
  );
});

function renderTab(skill: Skill = SKILL) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ skills: messages }}>
        <ContextTab skill={skill} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const rowFor = (rows: HTMLElement[], name: string) =>
  rows.find((r) => within(r).queryByText(name))!;

describe("ContextTab", () => {
  it("renders attached-first rows, the attached count, the inheritance note, and the serializes-as path list", async () => {
    renderTab();
    const rows = await screen.findAllByRole("listitem");
    // Attached first (in attached order), then the rest in discovery order.
    expect(within(rows[0]!).getByText("setup.md")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("auth.md")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("perf.md")).toBeInTheDocument();

    expect(screen.getByText("2 attached")).toBeInTheDocument();
    expect(
      screen.getByText(/Any agent using this skill inherits these documents\./),
    ).toBeInTheDocument();

    // Row anatomy: root-dir badge (text label) + per-row token count + full path
    // + preview affordance.
    expect(within(rows[1]!).getByText("specs")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("specs/auth.md")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("~120 tokens")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview auth.md" })).toBeInTheDocument();
    // server/notes/arch.md → badge "server" (root dir), NOT its bucket "docs".
    const archRow = rowFor(rows, "arch.md");
    expect(within(archRow).getByText("server")).toBeInTheDocument();
    expect(within(archRow).queryByText("docs")).not.toBeInTheDocument();
    expect(within(archRow).getByText("~60 tokens")).toBeInTheDocument();

    // "Serializes as" — the contribution heading + the attached paths (AC-17).
    const pre = screen.getByText(/## Project context/);
    expect(pre.textContent).toContain("- docs/guide/setup.md");
    expect(pre.textContent).toContain("- specs/auth.md");
  });

  it("attaching a document PUTs the full ordered path set with the new path appended", async () => {
    renderTab();
    const rows = await screen.findAllByRole("listitem");
    fireEvent.click(within(rowFor(rows, "perf.md")).getByRole("checkbox"));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/skills/sk1/attached-docs", {
        paths: ["docs/guide/setup.md", "specs/auth.md", "insights/perf.md"],
      }),
    );
  });

  it("detaching a document PUTs the full ordered path set without it", async () => {
    renderTab();
    const rows = await screen.findAllByRole("listitem");
    fireEvent.click(within(rowFor(rows, "setup.md")).getByRole("checkbox"));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/skills/sk1/attached-docs", {
        paths: ["specs/auth.md"],
      }),
    );
  });

  it("keyboard reorder (move up) PUTs the reordered path set", async () => {
    renderTab();
    await screen.findAllByRole("listitem");
    fireEvent.click(screen.getByRole("button", { name: "Move auth.md up" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/skills/sk1/attached-docs", {
        paths: ["specs/auth.md", "docs/guide/setup.md"],
      }),
    );
  });

  it("search narrows the list by filename/path without changing attach state", async () => {
    renderTab();
    await screen.findAllByRole("listitem");
    const search = screen.getByPlaceholderText("Search documents…");

    fireEvent.change(search, { target: { value: "perf" } });
    let rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText("perf.md")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "" } });
    rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    // Toggles set before filtering remain set; no persistence call happened.
    expect(within(rowFor(rows, "setup.md")).getByRole("checkbox")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(api.put).not.toHaveBeenCalled();
  });
});
