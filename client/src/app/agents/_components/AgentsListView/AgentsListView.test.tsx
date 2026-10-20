import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import type { Agent, AgentListItem } from "@devdigest/shared";
import { renderWithProviders, type RouteRequest } from "@/test/render-with-providers";
import { AgentsListView } from "./AgentsListView";

/* AC-33 (Agents row of the UI gating table): creating an agent is Admin-only —
   a Member gets "Add Agent" focusable but aria-disabled with the visible
   "Admins only" hint, no menu, an aria-disabled per-card toggle and no delete. */

vi.mock("next/navigation", () => ({
  usePathname: () => "/agents",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const AGENT: AgentListItem = {
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
  attached_doc_paths: [],
  skill_count: 2,
};

/** In-memory agents API: PUT applies the patch, the list re-reads it. */
function agentsApi(initial: AgentListItem[]) {
  let agents = initial;
  return {
    "GET /agents": () => agents,
    "PUT /agents/:id": (req: RouteRequest) => {
      const patch = req.body as Partial<Agent>;
      agents = agents.map((a) => (a.id === req.params.id ? { ...a, ...patch } : a));
      return agents.find((a) => a.id === req.params.id);
    },
  };
}

describe("AgentsListView — role gating (AC-33)", () => {
  it("Member: Add Agent is aria-disabled with an 'Admins only' description and opens no menu", async () => {
    renderWithProviders(<AgentsListView />, { session: "member", routes: agentsApi([AGENT]) });

    expect(await screen.findByText("Security Reviewer")).toBeInTheDocument();
    const add = await screen.findByRole("button", { name: "Add Agent", description: "Admins only" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    add.focus();
    expect(add).toHaveFocus();
    fireEvent.click(add);
    expect(screen.queryByText("Create from scratch")).not.toBeInTheDocument();

    // The card is readable; its toggle is shown inert and Delete is not offered.
    const toggle = screen.getByRole("switch", { name: "Security Reviewer enabled" });
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("button", { name: "Delete agent" })).not.toBeInTheDocument();
  });

  it("Member with no agents: the empty state offers no create CTA", async () => {
    renderWithProviders(<AgentsListView />, { session: "member", routes: agentsApi([]) });

    expect(await screen.findByText("No agents yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create your first agent" })).not.toBeInTheDocument();
  });

  it("Admin: Add Agent opens the create menu; the toggle flips the agent and Delete is shown", async () => {
    const { router } = renderWithProviders(<AgentsListView />, { session: "admin", routes: agentsApi([AGENT]) });

    expect(await screen.findByRole("button", { name: "Delete agent" })).toBeInTheDocument();
    const add = screen.getByRole("button", { name: "Add Agent" });
    expect(add).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByText("Admins only")).not.toBeInTheDocument();
    fireEvent.click(add);
    expect(screen.getByText("Create from scratch")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Security Reviewer enabled" }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Security Reviewer enabled" })).toHaveAttribute(
        "aria-checked",
        "false",
      ),
    );
    expect(router.calls.find((c) => c.method === "PUT")?.body).toEqual({ enabled: false });
  });
});
