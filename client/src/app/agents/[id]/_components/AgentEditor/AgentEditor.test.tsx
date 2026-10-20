import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Agent } from "@devdigest/shared";
import { renderWithProviders, type RouteRequest } from "@/test/render-with-providers";
import { AgentEditor } from "./AgentEditor";

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

function renderEditor(session: "admin" | "member" = "admin") {
  return renderWithProviders(<AgentEditor agent={AGENT} tab="config" onTab={() => {}} />, {
    session,
    routes: {
      "GET /providers/openai/models": [{ id: "gpt-4.1", provider: "openai" }],
      "PUT /agents/ag1": (req: RouteRequest) => ({ ...AGENT, ...(req.body as Partial<Agent>), version: 2 }),
    },
  });
}

describe("A2 Agent Editor (smoke)", () => {
  it("renders the Config tab fields", () => {
    renderEditor();
    expect(screen.getByText("Config")).toBeInTheDocument();
    expect(screen.getByText("Configuration")).toBeInTheDocument();
    expect(screen.getByText("Save agent")).toBeInTheDocument();
  });
});

/* AC-33: editing an agent is Admin-only — a Member reads the config, but Save
   stays focusable, aria-disabled and described by the visible "Admins only". */
describe("A2 Agent Editor — role gating (AC-33)", () => {
  it("Member: Save agent is aria-disabled with an 'Admins only' description and saves nothing", async () => {
    const user = userEvent.setup();
    const { router } = renderEditor("member");

    const save = await screen.findByRole("button", { name: "Save agent", description: "Admins only" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Admins only")).toBeVisible();
    await user.click(save);
    // Sync point: a later interaction the Member CAN do, awaited until visible —
    // any PUT the gated click had started is recorded (and rendered) by then.
    const name = screen.getByDisplayValue("Security Reviewer");
    await user.type(name, " v2");
    expect(await screen.findByDisplayValue("Security Reviewer v2")).toBeInTheDocument();
    expect(screen.queryByText(/Saved \(v/)).not.toBeInTheDocument();
    expect(router.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("Admin: Save agent is enabled and saves", async () => {
    const user = userEvent.setup();
    const { router } = renderEditor("admin");

    const save = screen.getByRole("button", { name: "Save agent" });
    await waitFor(() => expect(save).not.toHaveAttribute("aria-disabled"));
    expect(screen.queryByText("Admins only")).not.toBeInTheDocument();
    await user.click(save);
    expect(await screen.findByText(/Saved \(v2\)/)).toBeInTheDocument();
    expect(router.calls.find((c) => c.method === "PUT")?.body).toMatchObject({ name: "Security Reviewer" });
  });
});
