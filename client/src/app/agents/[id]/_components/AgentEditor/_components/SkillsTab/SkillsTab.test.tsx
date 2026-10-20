import { describe, it, expect } from "vitest";
import { screen, within, fireEvent, waitFor } from "@testing-library/react";
import type { Agent, AgentSkillLink, Skill } from "@devdigest/shared";
import { renderWithProviders, type RouteRequest } from "@/test/render-with-providers";
import { SkillsTab } from "./SkillsTab";

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
  attached_doc_paths: [],
};

const skill = (id: string, name: string, over: Partial<Skill> = {}): Skill => ({
  id,
  name,
  description: `${name} description`,
  type: "rubric",
  source: "manual",
  body: "- rule",
  enabled: true,
  version: 1,
  attached_doc_paths: [],
  ...over,
});

const SKILLS: Skill[] = [
  skill("a", "alpha-skill"),
  skill("b", "beta-skill", { type: "convention" }),
  skill("c", "gamma-skill"),
  skill("d", "delta-skill", { enabled: false, type: "custom" }),
];

// Linked: gamma first, then alpha.
const LINKS: AgentSkillLink[] = [
  { agent_id: "ag1", skill_id: "c", order: 0 },
  { agent_id: "ag1", skill_id: "a", order: 1 },
];

/** In-memory links API: POST replaces the agent's full ordered set. */
function renderTab(session: "admin" | "member" = "admin") {
  let links = LINKS;
  return renderWithProviders(<SkillsTab agent={AGENT} />, {
    session,
    routes: {
      "GET /skills": SKILLS,
      "GET /agents/ag1/skills": () => links,
      "POST /agents/ag1/skills": (req: RouteRequest) => {
        const { skill_ids } = req.body as { skill_ids: string[] };
        links = skill_ids.map((id, i): AgentSkillLink => ({ agent_id: "ag1", skill_id: id, order: i }));
        return links;
      },
      "GET /agents/ag1": AGENT,
      "GET /agents": [],
    },
  });
}

const rowNames = () => screen.getAllByRole("listitem").map((r) => within(r).getByText(/-skill$/).textContent);

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

describe("SkillsTab", () => {
  it("renders linked skills first in link order, then unlinked", async () => {
    renderTab();
    await screen.findAllByRole("listitem");
    expect(rowNames()).toEqual(["gamma-skill", "alpha-skill", "beta-skill", "delta-skill"]);
    expect(screen.getByText("2 of 4 enabled")).toBeInTheDocument();
  });

  it("linking a skill appends it to the full ordered set", async () => {
    const { router } = renderTab();
    fireEvent.click(await findLiveCheckbox("beta-skill"));
    expect(await screen.findByText("3 of 4 enabled")).toBeInTheDocument();
    expect(rowNames()).toEqual(["gamma-skill", "alpha-skill", "beta-skill", "delta-skill"]);
    expect(router.calls.find((c) => c.method === "POST")?.body).toEqual({ skill_ids: ["c", "a", "b"] });
  });

  it("unlinking a skill drops it from the set", async () => {
    renderTab();
    fireEvent.click(await findLiveCheckbox("alpha-skill"));
    expect(await screen.findByText("1 of 4 enabled")).toBeInTheDocument();
    expect(within(rowFor("alpha-skill")).getByRole("checkbox")).toHaveAttribute("aria-checked", "false");
  });

  it("drag-reordering linked rows saves the new full order", async () => {
    renderTab();
    await findLiveCheckbox("alpha-skill");
    const alphaRow = rowFor("alpha-skill");
    fireEvent.dragStart(alphaRow);
    fireEvent.dragOver(rowFor("gamma-skill"));
    fireEvent.dragEnd(alphaRow);
    await waitFor(() => expect(rowNames().slice(0, 2)).toEqual(["alpha-skill", "gamma-skill"]));
  });

  it("renders globally-disabled skills muted with a disabled badge", async () => {
    renderTab();
    await screen.findAllByRole("listitem");
    const deltaRow = rowFor("delta-skill");
    expect(deltaRow).toHaveStyle({ opacity: "0.55" });
    expect(within(deltaRow).getByText("disabled")).toBeInTheDocument();
  });
});

/* AC-33: attaching skills is Admin-only — a Member sees the linked set read-only:
   checkboxes aria-disabled and described by the visible "Admins only" hint. */
describe("SkillsTab — role gating (AC-33)", () => {
  it("Member: read-only list; checkboxes are aria-disabled, described by 'Admins only', and inert", async () => {
    const { router } = renderTab("member");
    expect(await screen.findByText("Admins only")).toBeVisible();
    expect(rowNames()).toEqual(["gamma-skill", "alpha-skill", "beta-skill", "delta-skill"]);

    const beta = within(rowFor("beta-skill")).getByRole("checkbox");
    expect(beta).toHaveAttribute("aria-disabled", "true");
    expect(beta).toHaveAccessibleDescription("Admins only");
    fireEvent.click(beta);
    expect(beta).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("2 of 4 enabled")).toBeInTheDocument();
    expect(rowFor("gamma-skill")).toHaveAttribute("draggable", "false");
    expect(router.calls.some((c) => c.method === "POST")).toBe(false);
  });
});
