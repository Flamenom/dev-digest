import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { AgentListItem } from "@devdigest/shared";
import messages from "../../../../../messages/en/agents.json";
import authMessages from "../../../../../messages/en/auth.json";

/* AC-33 (Agents row of the UI gating table): creating an agent is Admin-only —
   a Member gets "Add Agent" focusable but aria-disabled with the visible
   "Admins only" hint, no menu, and no per-card toggle/delete. */

const state: { agents: AgentListItem[] } = { agents: [] };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/hooks/agents", () => ({
  useAgents: () => ({ data: state.agents, isLoading: false, isError: false, refetch: vi.fn() }),
  useUpdateAgent: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteAgent: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateAgent: () => ({ mutate: vi.fn(), isPending: false }),
}));

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

import { AgentsListView } from "./AgentsListView";

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

afterEach(() => {
  cleanup();
  state.agents = [];
  session.mode = "local";
  session.role = "admin";
});

function renderView() {
  render(
    <NextIntlClientProvider locale="en" messages={{ auth: authMessages, agents: messages }}>
      <AgentsListView />
    </NextIntlClientProvider>,
  );
}

describe("AgentsListView — role gating (AC-33)", () => {
  it("Member: Add Agent is aria-disabled with an 'Admins only' description and opens no menu", () => {
    session.mode = "google";
    session.role = "member";
    state.agents = [AGENT];
    renderView();

    const add = screen.getByRole("button", { name: "Add Agent" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).toHaveAccessibleDescription("Admins only");
    add.focus();
    expect(add).toHaveFocus();
    fireEvent.click(add);
    expect(screen.queryByText("Create from scratch")).not.toBeInTheDocument();

    // The card is readable, but its toggle and Delete are not offered.
    expect(screen.getByText("Security Reviewer")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete agent" })).not.toBeInTheDocument();
  });

  it("Member with no agents: the empty state offers no create CTA", () => {
    session.mode = "google";
    session.role = "member";
    renderView();

    expect(screen.queryByRole("button", { name: "Create your first agent" })).not.toBeInTheDocument();
  });

  it("Admin (local mode): Add Agent opens the create menu; toggle and Delete are shown", () => {
    state.agents = [AGENT];
    renderView();

    const add = screen.getByRole("button", { name: "Add Agent" });
    expect(add).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByText("Admins only")).not.toBeInTheDocument();
    fireEvent.click(add);
    expect(screen.getByText("Create from scratch")).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete agent" })).toBeInTheDocument();
  });
});
