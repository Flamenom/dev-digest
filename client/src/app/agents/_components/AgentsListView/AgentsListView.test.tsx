import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Agent, AgentListItem } from "@devdigest/shared";
import { renderWithProviders, type RouteRequest } from "@/test/render-with-providers";
import { RoleProbe, findRole } from "@/test/role-probe";
import { AgentsListView } from "./AgentsListView";

/* AC-33 (Agents row of the UI gating table): creating an agent is Admin-only —
   a Member gets "Add Agent" focusable but aria-disabled with the visible
   "Admins only" hint, no menu, an aria-disabled per-card toggle and no delete. */

const nav = vi.hoisted(() => ({
  search: new URLSearchParams(),
  router: { push: () => {}, replace: (() => {}) as (href: string, opts?: unknown) => void },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/agents",
  useRouter: () => nav.router,
  useSearchParams: () => nav.search,
}));

beforeEach(() => {
  nav.search = new URLSearchParams();
  nav.router = { push: vi.fn(), replace: vi.fn() };
});

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
    const user = userEvent.setup();
    renderWithProviders(<AgentsListView />, { session: "member", routes: agentsApi([AGENT]) });

    expect(await screen.findByText("Security Reviewer")).toBeInTheDocument();
    const add = await screen.findByRole("button", { name: "Add Agent", description: "Admins only" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    add.focus();
    expect(add).toHaveFocus();
    await user.click(add);
    expect(screen.queryByText("Create from scratch")).not.toBeInTheDocument();

    // The card is readable; its toggle is shown inert and Delete is not offered.
    const toggle = screen.getByRole("switch", { name: "Security Reviewer enabled" });
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("button", { name: "Delete agent" })).not.toBeInTheDocument();
  });

  it("Member with no agents: the empty state offers no create CTA", async () => {
    renderWithProviders(
      <>
        <RoleProbe />
        <AgentsListView />
      </>,
      { session: "member", routes: agentsApi([]) },
    );

    // Fail-closed while the session is pending: wait for the resolved Member
    // role (not just the data) before asserting the CTA is absent.
    await findRole("member");
    expect(await screen.findByText("No agents yet")).toBeInTheDocument();
    // AC-60: the Member is told only an Admin can create agents — not to create one.
    expect(screen.getByText(/Only an Admin can create agents/)).toBeInTheDocument();
    expect(screen.queryByText(/Create one to start reviewing/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create your first agent" })).not.toBeInTheDocument();
  });

  it("Admin with no agents: the empty state keeps its body and create CTA", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgentsListView />, { session: "admin", routes: agentsApi([]) });

    const cta = await screen.findByRole("button", { name: "Create your first agent" });
    expect(screen.getByText(/Create one to start reviewing/)).toBeInTheDocument();
    expect(screen.queryByText(/Only an Admin can create agents/)).not.toBeInTheDocument();
    await user.click(cta);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("?create=1 + Admin: the create modal opens and the param is consumed (AC-59)", async () => {
    nav.search = new URLSearchParams("create=1");
    renderWithProviders(<AgentsListView />, { session: "admin", routes: agentsApi([]) });

    expect(await screen.findByRole("dialog")).toHaveTextContent("Create agent");
    expect(nav.router.replace).toHaveBeenCalledWith(expect.not.stringContaining("create=1"), { scroll: false });
  });

  it("?create=1 + Member: the param is ignored and no modal opens", async () => {
    nav.search = new URLSearchParams("create=1");
    renderWithProviders(
      <>
        <RoleProbe />
        <AgentsListView />
      </>,
      { session: "member", routes: agentsApi([]) },
    );

    await findRole("member");
    expect(await screen.findByText("No agents yet")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Admin: Add Agent opens the create menu; the toggle flips the agent and Delete is shown", async () => {
    const user = userEvent.setup();
    const { router } = renderWithProviders(<AgentsListView />, { session: "admin", routes: agentsApi([AGENT]) });

    expect(await screen.findByRole("button", { name: "Delete agent" })).toBeInTheDocument();
    const add = screen.getByRole("button", { name: "Add Agent" });
    expect(add).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByText("Admins only")).not.toBeInTheDocument();
    await user.click(add);
    expect(screen.getByText("Create from scratch")).toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "Security Reviewer enabled" }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Security Reviewer enabled" })).toHaveAttribute(
        "aria-checked",
        "false",
      ),
    );
    expect(router.calls.find((c) => c.method === "PUT")?.body).toEqual({ enabled: false });
  });
});
