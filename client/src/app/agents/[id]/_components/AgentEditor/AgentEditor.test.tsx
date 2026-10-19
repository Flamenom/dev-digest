import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Agent } from "@devdigest/shared";
import messages from "../../../../../../messages/en/agents.json";
import authMessages from "../../../../../../messages/en/auth.json";
import { ToastProvider } from "@/lib/toast";

// Mock the data hooks so the editor renders without a network/query client.
const updateMutate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hooks/agents", () => ({
  useUpdateAgent: () => ({ mutate: updateMutate, isPending: false, isSuccess: false, data: undefined }),
  useProviderModels: () => ({ data: [{ id: "gpt-4.1", provider: "openai" }] }),
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

import { AgentEditor } from "./AgentEditor";

afterEach(() => {
  cleanup();
  session.mode = "local";
  session.role = "admin";
  updateMutate.mockClear();
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
  return render(
    <NextIntlClientProvider locale="en" messages={{ auth: authMessages, agents: messages }}>
      <ToastProvider>{ui}</ToastProvider>
    </NextIntlClientProvider>,
  );
}

describe("A2 Agent Editor (smoke)", () => {
  it("renders the Config tab fields", () => {
    renderWithIntl(<AgentEditor agent={AGENT} tab="config" onTab={() => {}} />);
    expect(screen.getByText("Config")).toBeInTheDocument();
    expect(screen.getByText("Configuration")).toBeInTheDocument();
    expect(screen.getByText("Save agent")).toBeInTheDocument();
  });
});

/* AC-33: editing an agent is Admin-only — a Member reads the config, but Save
   stays focusable, aria-disabled and described by the visible "Admins only". */
describe("A2 Agent Editor — role gating (AC-33)", () => {
  it("Member: Save agent is aria-disabled with an 'Admins only' description and saves nothing", () => {
    session.mode = "google";
    session.role = "member";
    renderWithIntl(<AgentEditor agent={AGENT} tab="config" onTab={() => {}} />);

    const save = screen.getByRole("button", { name: "Save agent" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(save).toHaveAccessibleDescription("Admins only");
    expect(screen.getByText("Admins only")).toBeVisible();
    fireEvent.click(save);
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it("Admin: Save agent is enabled and saves", () => {
    renderWithIntl(<AgentEditor agent={AGENT} tab="config" onTab={() => {}} />);

    const save = screen.getByRole("button", { name: "Save agent" });
    expect(save).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByText("Admins only")).not.toBeInTheDocument();
    fireEvent.click(save);
    expect(updateMutate).toHaveBeenCalledTimes(1);
  });
});
