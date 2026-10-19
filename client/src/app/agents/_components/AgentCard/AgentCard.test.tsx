import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@devdigest/shared";
import messages from "../../../../../messages/en/agents.json";

/* Multi-user gating reads the session probe: mocked as the local-mode Admin
   (every control enabled, as before); a test may flip `session` to a Member. */
const session = vi.hoisted(() => ({
  mode: "local" as "local" | "google",
  role: "admin" as "admin" | "member",
}));
vi.mock("@/lib/hooks/session", () => ({
  SESSION_QUERY_KEY: ["session"],
  useSession: () => ({
    data: {
      mode: session.mode,
      user: { id: "u1", email: "a@onlytraf.com", name: "Ann", avatar_url: null, role: session.role },
      workspace: { id: "w1", name: "Team" },
    },
    isPending: false,
  }),
}));

import { AgentCard } from "./AgentCard";

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

function renderWithIntl(ui: React.ReactElement) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ agents: messages }}>
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("AgentCard (smoke)", () => {
  it("renders the agent name, model chip and skill count", () => {
    renderWithIntl(<AgentCard ag={AGENT} skillCount={3} />);
    expect(screen.getByText("Security Reviewer")).toBeInTheDocument();
    expect(screen.getByText("gpt-4.1")).toBeInTheDocument();
    expect(screen.getByText("3 skills")).toBeInTheDocument();
  });

  it("falls back to a translated placeholder when description is empty", () => {
    renderWithIntl(<AgentCard ag={{ ...AGENT, description: "" }} />);
    expect(screen.getByText("No description")).toBeInTheDocument();
  });
});

/* AC-33: the enabled toggle (an agent edit) and Delete agent are Admin-only —
   a Member sees neither; local mode (Admin) keeps both. */
describe("AgentCard — role gating (AC-33)", () => {
  it("Admin sees the enabled toggle and Delete agent", () => {
    renderWithIntl(<AgentCard ag={AGENT} onToggle={() => {}} />);
    expect(screen.getByRole("switch")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete agent" })).toBeInTheDocument();
  });

  it("Member sees neither the toggle nor Delete agent", () => {
    session.mode = "google";
    session.role = "member";
    renderWithIntl(<AgentCard ag={AGENT} onToggle={() => {}} />);
    expect(screen.getByText("Security Reviewer")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete agent" })).not.toBeInTheDocument();
  });
});
