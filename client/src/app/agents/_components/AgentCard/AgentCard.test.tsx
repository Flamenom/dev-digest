import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import type { Agent } from "@devdigest/shared";
import { renderWithProviders } from "@/test/render-with-providers";
import { AgentCard } from "./AgentCard";

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

describe("AgentCard (smoke)", () => {
  it("renders the agent name, model chip and skill count", () => {
    renderWithProviders(<AgentCard ag={AGENT} skillCount={3} />);
    expect(screen.getByText("Security Reviewer")).toBeInTheDocument();
    expect(screen.getByText("gpt-4.1")).toBeInTheDocument();
    expect(screen.getByText("3 skills")).toBeInTheDocument();
  });

  it("falls back to a translated placeholder when description is empty", () => {
    renderWithProviders(<AgentCard ag={{ ...AGENT, description: "" }} />);
    expect(screen.getByText("No description")).toBeInTheDocument();
  });
});

/* AC-33: the enabled toggle (an agent edit) is Admin-only — a Member sees it
   aria-disabled and inert; Delete agent (destructive) stays hidden for them. */
describe("AgentCard — role gating (AC-33)", () => {
  it("Admin: the enabled toggle works and Delete agent is offered", async () => {
    const onToggle = vi.fn();
    renderWithProviders(<AgentCard ag={AGENT} onToggle={onToggle} />, { session: "admin" });

    expect(await screen.findByRole("button", { name: "Delete agent" })).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "Security Reviewer enabled" });
    expect(toggle).not.toHaveAttribute("aria-disabled");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("Member: the toggle is shown aria-disabled and inert; Delete agent is hidden", async () => {
    const onToggle = vi.fn();
    renderWithProviders(<AgentCard ag={AGENT} onToggle={onToggle} />, { session: "member" });

    const toggle = await screen.findByRole("switch", { name: "Security Reviewer enabled" });
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Delete agent" })).not.toBeInTheDocument();
  });
});
