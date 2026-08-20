import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Skill, SkillStats } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/skills.json";

let statsData: SkillStats | undefined;
vi.mock("@/lib/hooks/skills", () => ({
  useSkillStats: () => ({ data: statsData }),
}));

import { StatsTab } from "./StatsTab";

afterEach(() => {
  cleanup();
  statsData = undefined;
});

const SKILL: Skill = {
  id: "sk1",
  name: "breaking-change",
  description: "d",
  type: "convention",
  source: "manual",
  body: "b",
  enabled: true,
  version: 2,
};

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ skills: messages }}>
      <StatsTab skill={SKILL} />
    </NextIntlClientProvider>,
  );
}

describe("StatsTab", () => {
  it("renders the per-skill stats: used-by count and the linking agents", () => {
    statsData = {
      skill_id: "sk1",
      used_by_agents: 1,
      agents: [{ id: "a1", name: "API Contract Reviewer" }],
      version_count: 2,
      latest_version: 2,
      last_updated_at: "2026-08-19T00:00:00.000Z",
    };
    renderTab();
    expect(screen.getByText("1 agent")).toBeInTheDocument();
    expect(screen.getByText("API Contract Reviewer")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open/ })).toHaveAttribute("href", "/agents/a1");
  });

  it("shows the empty state while stats are loading or the skill is unlinked", () => {
    renderTab();
    expect(screen.getByText("0 agents")).toBeInTheDocument();
    expect(screen.getByText("No agents use this skill yet.")).toBeInTheDocument();
  });
});
