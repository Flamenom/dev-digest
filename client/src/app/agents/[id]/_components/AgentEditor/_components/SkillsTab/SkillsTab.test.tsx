import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from "vitest";
import { render, screen, within, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, AgentSkillLink, Skill } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/agents.json";
import authMessages from "../../../../../../../../messages/en/auth.json";

// SkillsTab talks to the API through lib/api only — mock it wholesale.
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

/* Multi-user gating reads the session probe: mocked as the local-mode Admin
   (every control enabled, as before); a test may flip `session` to a Member. */
const session = vi.hoisted(() => ({
  mode: "local" as "local" | "google",
  role: "admin" as "admin" | "member",
  userId: "u-admin",
}));
vi.mock("@/lib/hooks/session", () => ({
  SESSION_QUERY_KEY: ["session"],
  useSession: () => ({
    data: {
      mode: session.mode,
      user: { id: session.userId, email: "a@onlytraf.com", name: "Ann", avatar_url: null, role: session.role },
      workspace: { id: "w1", name: "Team" },
    },
    isPending: false,
  }),
}));

import { api } from "@/lib/api";
import { SkillsTab } from "./SkillsTab";

afterEach(() => {
  cleanup();
  session.mode = "local";
  session.role = "admin";
});

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

beforeEach(() => {
  vi.clearAllMocks();
  (api.get as Mock).mockImplementation((path: string) => {
    if (path === "/skills") return Promise.resolve(SKILLS);
    if (path === "/agents/ag1/skills") return Promise.resolve(LINKS);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  (api.post as Mock).mockImplementation((_path: string, body: { skill_ids: string[] }) =>
    Promise.resolve(
      body.skill_ids.map((id, i): AgentSkillLink => ({ agent_id: "ag1", skill_id: id, order: i })),
    ),
  );
});

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ auth: authMessages, agents: messages }}>
        <SkillsTab agent={AGENT} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const rowNames = (rows: HTMLElement[]) =>
  rows.map((r) => within(r).getByText(/-skill$/).textContent);

describe("SkillsTab", () => {
  it("renders linked skills first in link order, then unlinked", async () => {
    renderTab();
    const rows = await screen.findAllByRole("listitem");
    expect(rowNames(rows)).toEqual(["gamma-skill", "alpha-skill", "beta-skill", "delta-skill"]);
    expect(screen.getByText("2 of 4 enabled")).toBeInTheDocument();
  });

  it("linking a skill posts the full ordered set with the new id appended", async () => {
    renderTab();
    const rows = await screen.findAllByRole("listitem");
    const betaRow = rows.find((r) => within(r).queryByText("beta-skill"))!;
    fireEvent.click(within(betaRow).getByRole("checkbox"));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/agents/ag1/skills", { skill_ids: ["c", "a", "b"] }),
    );
  });

  it("unlinking a skill posts the full ordered set without it", async () => {
    renderTab();
    const rows = await screen.findAllByRole("listitem");
    const alphaRow = rows.find((r) => within(r).queryByText("alpha-skill"))!;
    fireEvent.click(within(alphaRow).getByRole("checkbox"));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/agents/ag1/skills", { skill_ids: ["c"] }),
    );
  });

  it("drag-reordering linked rows posts the new full order", async () => {
    renderTab();
    const rows = await screen.findAllByRole("listitem");
    const alphaRow = rows.find((r) => within(r).queryByText("alpha-skill"))!;
    const gammaRow = rows.find((r) => within(r).queryByText("gamma-skill"))!;
    fireEvent.dragStart(alphaRow);
    fireEvent.dragOver(gammaRow);
    fireEvent.dragEnd(alphaRow);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/agents/ag1/skills", { skill_ids: ["a", "c"] }),
    );
  });

  it("renders globally-disabled skills muted with a disabled badge", async () => {
    renderTab();
    const rows = await screen.findAllByRole("listitem");
    const deltaRow = rows.find((r) => within(r).queryByText("delta-skill"))!;
    expect(deltaRow).toHaveStyle({ opacity: "0.55" });
    expect(within(deltaRow).getByText("disabled")).toBeInTheDocument();
  });
});

/* AC-33: attaching skills is Admin-only — a Member sees the linked set read-only
   with the visible "Admins only" hint, and toggling posts nothing. */
describe("SkillsTab — role gating (AC-33)", () => {
  it("Member: read-only list with the 'Admins only' hint; clicking a checkbox posts nothing", async () => {
    session.mode = "google";
    session.role = "member";
    renderTab();
    const rows = await screen.findAllByRole("listitem");
    expect(rowNames(rows)).toEqual(["gamma-skill", "alpha-skill", "beta-skill", "delta-skill"]);
    expect(screen.getByText("Admins only")).toBeVisible();

    const betaRow = rows.find((r) => within(r).queryByText("beta-skill"))!;
    fireEvent.click(within(betaRow).getByRole("checkbox"));
    expect(api.post).not.toHaveBeenCalled();
    expect(rows[0]).toHaveAttribute("draggable", "false");
  });
});
