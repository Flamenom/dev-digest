import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from "vitest";
import { render, screen, within, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, DiscoveredDocument, DiscoverySummary, Repo } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/agents.json";

// ContextTab talks to the API through lib/api only — mock it wholesale.
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

import { api } from "@/lib/api";
import { ContextTab } from "./ContextTab";

afterEach(cleanup);

const AGENT: Agent = {
  id: "ag1",
  name: "Security Reviewer",
  description: "Flags secrets and injection",
  provider: "openai",
  model: "gpt-4.1",
  system_prompt: "You are a security reviewer.",
  output_schema: null,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
  enabled: true,
  version: 1,
  // Attached in this order: beta first, then alpha.
  attached_doc_paths: ["docs/beta.md", "specs/alpha.md"],
};

const REPOS: Repo[] = [
  {
    id: "r1",
    workspace_id: "ws1",
    owner: "acme",
    name: "widget",
    full_name: "acme/widget",
    default_branch: "main",
    clone_path: "/clones/acme/widget",
    last_polled_at: null,
    created_by: null,
  },
];

const DOCUMENTS: DiscoveredDocument[] = [
  { path: "docs/beta.md", bucket: "docs", estimated_tokens: 200, used_by_agents: 1 },
  { path: "insights/deep/gamma.md", bucket: "insights", estimated_tokens: 300, used_by_agents: 0 },
  { path: "specs/alpha.md", bucket: "specs", estimated_tokens: 100, used_by_agents: 2 },
  // Root dir ("server") differs from the bucket ("docs") — badge shows the root dir.
  { path: "server/docs/api.md", bucket: "docs", estimated_tokens: 50, used_by_agents: 0 },
];

const SUMMARY: DiscoverySummary = {
  document_count: 4,
  total_estimated_tokens: 650,
  refreshed_at: "2026-08-27T00:00:00.000Z",
  clone_available: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  (api.get as Mock).mockImplementation((path: string) => {
    if (path === "/repos") return Promise.resolve(REPOS);
    if (path === "/repos/r1/project-context")
      return Promise.resolve({ documents: DOCUMENTS, summary: SUMMARY });
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  (api.put as Mock).mockImplementation((_path: string, body: { paths: string[] }) =>
    Promise.resolve({ ...AGENT, attached_doc_paths: body.paths }),
  );
});

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ agents: messages }}>
        <ContextTab agent={AGENT} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const rowNames = (rows: HTMLElement[]) =>
  rows.map((r) => within(r).getByText(/\.md$/).textContent);

describe("ContextTab", () => {
  it("renders attached docs first with the count, token estimate, per-row tokens, root-dir badges and untrusted note", async () => {
    renderTab();
    const rows = await screen.findAllByRole("listitem");
    // Attached (beta, alpha — attach order) first, then the rest (gamma, api).
    expect(rowNames(rows)).toEqual(["beta.md", "alpha.md", "gamma.md", "api.md"]);
    expect(screen.getByText("2 of 4 attached")).toBeInTheDocument();
    // Running estimate over the attached set: 200 + 100.
    expect(screen.getByText("≈ 300 tokens attached")).toBeInTheDocument();
    expect(
      screen.getByText(/Injected as an untrusted block \(## Project context\) into every run\./),
    ).toBeInTheDocument();
    // Rows show the folder path, a root-dir badge with a text label (not colour
    // alone) and the file's own token count.
    const gammaRow = rows[2]!;
    expect(within(gammaRow).getByText("insights/deep")).toBeInTheDocument();
    expect(within(gammaRow).getByText("insights")).toBeInTheDocument();
    expect(within(gammaRow).getByText("300 tokens")).toBeInTheDocument();
    // server/docs/api.md → badge "server" (root dir), NOT its bucket "docs".
    const apiRow = rows[3]!;
    expect(within(apiRow).getByText("server")).toBeInTheDocument();
    expect(within(apiRow).queryByText("docs")).not.toBeInTheDocument();
    expect(within(apiRow).getByText("50 tokens")).toBeInTheDocument();
  });

  it("attaching a document PUTs the full ordered path set with the new path appended", async () => {
    renderTab();
    const rows = await screen.findAllByRole("listitem");
    const gammaRow = rows.find((r) => within(r).queryByText("gamma.md"))!;
    fireEvent.click(within(gammaRow).getByRole("checkbox"));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/agents/ag1/attached-docs", {
        paths: ["docs/beta.md", "specs/alpha.md", "insights/deep/gamma.md"],
      }),
    );
  });

  it("detaching a document PUTs the full ordered path set without it", async () => {
    renderTab();
    const rows = await screen.findAllByRole("listitem");
    const betaRow = rows.find((r) => within(r).queryByText("beta.md"))!;
    fireEvent.click(within(betaRow).getByRole("checkbox"));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/agents/ag1/attached-docs", {
        paths: ["specs/alpha.md"],
      }),
    );
  });

  it("search narrows the list by filename/path without changing attach state", async () => {
    renderTab();
    await screen.findAllByRole("listitem");
    fireEvent.change(screen.getByPlaceholderText("Filter documents…"), {
      target: { value: "alpha" },
    });
    const filtered = screen.getAllByRole("listitem");
    expect(rowNames(filtered)).toEqual(["alpha.md"]);
    // Attach state is keyed by path — the visible attached row stays checked
    // and no mutation was fired by filtering.
    expect(within(filtered[0]!).getByRole("checkbox")).toBeChecked();
    expect(api.put).not.toHaveBeenCalled();
    // Clearing the filter restores every row with attach state intact.
    fireEvent.change(screen.getByPlaceholderText("Filter documents…"), {
      target: { value: "" },
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("2 of 4 attached")).toBeInTheDocument();
  });

  it("move buttons (keyboard alternative to drag) persist the reordered path set", async () => {
    renderTab();
    const rows = await screen.findAllByRole("listitem");
    const alphaRow = rows.find((r) => within(r).queryByText("alpha.md"))!;
    fireEvent.click(within(alphaRow).getByRole("button", { name: "Move up" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/agents/ag1/attached-docs", {
        paths: ["specs/alpha.md", "docs/beta.md"],
      }),
    );
  });

  it("drag-reordering attached rows persists the new full order", async () => {
    renderTab();
    const rows = await screen.findAllByRole("listitem");
    const alphaRow = rows.find((r) => within(r).queryByText("alpha.md"))!;
    const betaRow = rows.find((r) => within(r).queryByText("beta.md"))!;
    fireEvent.dragStart(alphaRow);
    fireEvent.dragOver(betaRow);
    fireEvent.dragEnd(alphaRow);
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/agents/ag1/attached-docs", {
        paths: ["specs/alpha.md", "docs/beta.md"],
      }),
    );
  });
});
