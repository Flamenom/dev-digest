import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Role } from "@devdigest/shared";
import { apiError, renderWithProviders, type RouteRequest, type Routes } from "@/test/render-with-providers";
import { RoleProbe, findRole } from "@/test/role-probe";
import { RunReviewDropdown } from "./RunReviewDropdown";

/* Zero-agents empty states (AC-58, AC-59) + the 409 `no_enabled_agents` toast.
   Real providers; the agents list, session and POST /pulls/:id/review are served
   by the shared fetch router. Only next/navigation (no App Router in jsdom) is mocked. */

const nav = vi.hoisted(() => ({ push: (() => {}) as (href: string) => void }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/repos/r1/pulls/7",
  useRouter: () => ({ push: (href: string) => nav.push(href), replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  nav.push = vi.fn();
});

const agent = (id: string, name: string, enabled: boolean) => ({
  id,
  name,
  description: "",
  provider: "openai",
  model: "gpt-4.1",
  system_prompt: "",
  output_schema: null,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
  enabled,
  version: 1,
  attached_doc_paths: [],
  skill_count: 0,
});
const ENABLED = agent("a1", "Security", true);
const DISABLED = agent("a2", "Style", false);

function setup({ agents, session = "admin", routes = {} }: { agents: unknown[]; session?: Role; routes?: Routes }) {
  const onRunsStarted = vi.fn();
  const user = userEvent.setup();
  const result = renderWithProviders(
    <>
      <RoleProbe />
      <RunReviewDropdown prId="pr1" onRunsStarted={onRunsStarted} />
    </>,
    {
      session,
      routes: { "GET /agents": agents, "POST /pulls/:id/review": { runs: [{ run_id: "r1" }] }, ...routes },
    },
  );
  return { ...result, user, onRunsStarted };
}

/** Wait for the role + agents to resolve, then open the menu. */
async function openMenu(user: ReturnType<typeof userEvent.setup>, role: Role, waitForEntry: string) {
  await findRole(role);
  await user.click(screen.getByText("Run Review"));
  await screen.findByRole("button", { name: new RegExp(waitForEntry) });
}

const reviewPosts = (calls: RouteRequest[]) =>
  calls.filter((c) => c.method === "POST" && c.path === "/pulls/pr1/review");

describe("RunReviewDropdown", () => {
  it("enabled agent: Run all starts an all-agents review and hands the run ids up", async () => {
    const { user, router, onRunsStarted } = setup({ agents: [ENABLED] });
    await openMenu(user, "admin", "Security");

    const runAll = screen.getByRole("button", { name: /Run all enabled agents/ });
    expect(runAll).not.toHaveAttribute("aria-disabled");
    await user.click(runAll);

    await vi.waitFor(() => expect(onRunsStarted).toHaveBeenCalledWith(["r1"]));
    expect(reviewPosts(router.calls)[0]?.body).toEqual({ all: true });
  });

  it("only disabled agents: Run all is inert with a localized hint and sends nothing (AC-58)", async () => {
    const { user, router } = setup({ agents: [DISABLED] });
    await openMenu(user, "admin", "Style");

    const runAll = screen.getByRole("button", { name: /Run all enabled agents/ });
    expect(runAll).toHaveAttribute("aria-disabled", "true");
    expect(runAll).toHaveAccessibleDescription("No agent is enabled — enable or create one first.");
    await user.click(runAll);
    expect(reviewPosts(router.calls)).toHaveLength(0);
    // The disabled agent itself stays listed and runnable.
    expect(screen.getByRole("button", { name: /Style/ })).toBeInTheDocument();
  });

  it("zero agents + Admin: the entry opens the Agents create flow (AC-59)", async () => {
    const { user } = setup({ agents: [] });
    await openMenu(user, "admin", "No agents yet — create one");

    expect(screen.getByRole("button", { name: /Run all enabled agents/ })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("button", { name: "No agents yet — create one" }));
    expect(nav.push).toHaveBeenCalledWith("/agents?create=1");
  });

  it("zero agents + Member: the entry is inert and asks for an Admin (AC-59)", async () => {
    const { user } = setup({ agents: [], session: "member" });
    await openMenu(user, "member", "No agents yet — ask an Admin to create one");

    expect(screen.queryByText("No agents yet — create one")).not.toBeInTheDocument();
    const entry = screen.getByRole("button", { name: "No agents yet — ask an Admin to create one" });
    expect(entry).toHaveAttribute("aria-disabled", "true");
    await user.click(entry);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("server 409 no_enabled_agents (stale list): shows the localized error toast", async () => {
    const { user } = setup({
      agents: [ENABLED],
      routes: { "POST /pulls/:id/review": () => apiError(409, "no_enabled_agents", "No enabled agents") },
    });
    await openMenu(user, "admin", "Security");

    await user.click(screen.getByRole("button", { name: /Run all enabled agents/ }));
    expect(
      await screen.findByText("No agent is enabled. Create or enable an agent, then run the review again."),
    ).toBeInTheDocument();
  });
});
