import { describe, it, expect } from "vitest";
import { screen, within, fireEvent, waitFor } from "@testing-library/react";
import type { Agent, DiscoveredDocument, DiscoverySummary } from "@devdigest/shared";
import { useAgent } from "@/lib/hooks/agents";
import { renderWithProviders, testRepo, type RouteRequest } from "@/test/render-with-providers";
import { ContextTab } from "./ContextTab";

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

const REPOS = [testRepo({ name: "widget", full_name: "acme/widget", clone_path: "/clones/acme/widget" })];

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

/** Renders the tab from the real agent query, as the editor page does — so a
    saved attach/reorder shows up once the agent re-reads. */
function AgentContextFromApi() {
  const { data } = useAgent("ag1");
  return data ? <ContextTab agent={data} /> : null;
}

function renderTab(session: "admin" | "member" = "admin") {
  let agent = AGENT;
  return renderWithProviders(<AgentContextFromApi />, {
    session,
    routes: {
      "GET /repos": REPOS,
      "GET /repos/r1/project-context": { documents: DOCUMENTS, summary: SUMMARY },
      "GET /agents/ag1": () => agent,
      "GET /agents": [],
      "PUT /agents/ag1/attached-docs": (req: RouteRequest) => {
        agent = { ...agent, attached_doc_paths: (req.body as { paths: string[] }).paths };
        return agent;
      },
    },
  });
}

const rowNames = () => screen.getAllByRole("listitem").map((r) => within(r).getByText(/\.md$/).textContent);

function rowFor(name: string): HTMLElement {
  const row = screen.getAllByRole("listitem").find((r) => within(r).queryByText(name));
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

/** A row's checkbox once the session resolved to Admin (live). */
async function findLiveCheckbox(name: string) {
  await screen.findAllByRole("listitem");
  const box = within(rowFor(name)).getByRole("checkbox");
  await waitFor(() => expect(box).not.toHaveAttribute("aria-disabled"));
  return box;
}

describe("ContextTab", () => {
  it("renders attached docs first with the count, token estimate, per-row tokens, root-dir badges and untrusted note", async () => {
    renderTab();
    await screen.findAllByRole("listitem");
    // Attached (beta, alpha — attach order) first, then the rest (gamma, api).
    expect(rowNames()).toEqual(["beta.md", "alpha.md", "gamma.md", "api.md"]);
    expect(screen.getByText("2 of 4 attached")).toBeInTheDocument();
    // Running estimate over the attached set: 200 + 100.
    expect(screen.getByText("≈ 300 tokens attached")).toBeInTheDocument();
    expect(
      screen.getByText(/Injected as an untrusted block \(## Project context\) into every run\./),
    ).toBeInTheDocument();
    // Rows show the folder path, a root-dir badge with a text label (not colour
    // alone) and the file's own token count.
    const gammaRow = rowFor("gamma.md");
    expect(within(gammaRow).getByText("insights/deep")).toBeInTheDocument();
    expect(within(gammaRow).getByText("insights")).toBeInTheDocument();
    expect(within(gammaRow).getByText("300 tokens")).toBeInTheDocument();
    // server/docs/api.md → badge "server" (root dir), NOT its bucket "docs".
    const apiRow = rowFor("api.md");
    expect(within(apiRow).getByText("server")).toBeInTheDocument();
    expect(within(apiRow).queryByText("docs")).not.toBeInTheDocument();
    expect(within(apiRow).getByText("50 tokens")).toBeInTheDocument();
  });

  it("attaching a document appends it to the ordered attached set", async () => {
    const { router } = renderTab();
    fireEvent.click(await findLiveCheckbox("gamma.md"));
    expect(await screen.findByText("3 of 4 attached")).toBeInTheDocument();
    expect(rowNames().slice(0, 3)).toEqual(["beta.md", "alpha.md", "gamma.md"]);
    expect(router.calls.find((c) => c.method === "PUT")?.body).toEqual({
      paths: ["docs/beta.md", "specs/alpha.md", "insights/deep/gamma.md"],
    });
  });

  it("detaching a document drops it from the attached set", async () => {
    renderTab();
    fireEvent.click(await findLiveCheckbox("beta.md"));
    expect(await screen.findByText("1 of 4 attached")).toBeInTheDocument();
    expect(within(rowFor("beta.md")).getByRole("checkbox")).not.toBeChecked();
  });

  it("search narrows the list by filename/path without changing attach state", async () => {
    const { router } = renderTab();
    await screen.findAllByRole("listitem");
    fireEvent.change(screen.getByPlaceholderText("Filter documents…"), {
      target: { value: "alpha" },
    });
    expect(rowNames()).toEqual(["alpha.md"]);
    // Attach state is keyed by path — the visible attached row stays checked.
    expect(within(rowFor("alpha.md")).getByRole("checkbox")).toBeChecked();
    // Clearing the filter restores every row with attach state intact.
    fireEvent.change(screen.getByPlaceholderText("Filter documents…"), {
      target: { value: "" },
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("2 of 4 attached")).toBeInTheDocument();
    expect(router.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("move buttons (keyboard alternative to drag) reorder the attached set", async () => {
    renderTab();
    await findLiveCheckbox("alpha.md");
    fireEvent.click(within(rowFor("alpha.md")).getByRole("button", { name: "Move up" }));
    await waitFor(() => expect(rowNames().slice(0, 2)).toEqual(["alpha.md", "beta.md"]));
  });

  it("drag-reordering attached rows saves the new full order", async () => {
    renderTab();
    await findLiveCheckbox("alpha.md");
    const alphaRow = rowFor("alpha.md");
    fireEvent.dragStart(alphaRow);
    fireEvent.dragOver(rowFor("beta.md"));
    fireEvent.dragEnd(alphaRow);
    await waitFor(() => expect(rowNames().slice(0, 2)).toEqual(["alpha.md", "beta.md"]));
  });
});

/* AC-33: a Member sees the attached set read-only — attach checkboxes and move
   buttons are shown aria-disabled, described by the visible "Admins only". */
describe("ContextTab — role gating (AC-33)", () => {
  it("Member: checkboxes and move buttons are aria-disabled, described by 'Admins only', and inert", async () => {
    const { router } = renderTab("member");
    expect(await screen.findByText("Admins only")).toBeVisible();

    const gamma = within(rowFor("gamma.md")).getByRole("checkbox");
    expect(gamma).toHaveAttribute("aria-disabled", "true");
    expect(gamma).toHaveAccessibleDescription("Admins only");
    fireEvent.click(gamma);
    expect(gamma).not.toBeChecked();

    const moveUp = within(rowFor("alpha.md")).getByRole("button", { name: "Move up" });
    expect(moveUp).toHaveAttribute("aria-disabled", "true");
    expect(moveUp).toHaveAccessibleDescription("Admins only");
    fireEvent.click(moveUp);
    expect(rowNames().slice(0, 2)).toEqual(["beta.md", "alpha.md"]);
    expect(screen.getByText("2 of 4 attached")).toBeInTheDocument();
    expect(router.calls.some((c) => c.method === "PUT")).toBe(false);
  });
});
