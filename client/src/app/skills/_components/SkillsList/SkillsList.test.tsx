import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Skill } from "@devdigest/shared";
import messages from "../../../../../messages/en/skills.json";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useParams: () => ({ id: "sk1" }),
  useSearchParams: () => new URLSearchParams(),
}));

const updateMutate = vi.fn();
const SKILLS: Skill[] = [
  {
    id: "sk1",
    name: "branch-coverage-rubric",
    description: "Flags uncovered branches",
    type: "rubric",
    source: "manual",
    body: "# Rubric",
    enabled: true,
    version: 2,
    attached_doc_paths: [],
  },
  {
    id: "sk2",
    name: "mock-overuse-gate",
    description: "Flags tests that mock the unit under test",
    type: "convention",
    source: "community",
    body: "# Gate",
    enabled: false,
    version: 1,
    attached_doc_paths: [],
  },
];

vi.mock("@/lib/hooks/skills", () => ({
  useSkills: () => ({ data: SKILLS, isLoading: false, isError: false, refetch: vi.fn() }),
  useSkillsUsage: () => ({
    data: [{ skill_id: "sk1", agents: [{ id: "ag1", name: "Test Quality Reviewer" }] }],
  }),
  useUpdateSkill: () => ({ mutate: updateMutate, isPending: false }),
  useCreateSkill: () => ({ mutate: vi.fn(), isPending: false }),
  useImportSkillPreview: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

import { SkillsList } from "./SkillsList";

afterEach(cleanup);

function renderList() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ skills: messages }}>
      <SkillsList />
    </NextIntlClientProvider>,
  );
}

describe("SkillsList", () => {
  it("renders skill cards with usage stat, badges and vetting chip", () => {
    renderList();
    expect(screen.getByText("branch-coverage-rubric")).toBeInTheDocument();
    expect(screen.getByText("mock-overuse-gate")).toBeInTheDocument();
    expect(screen.getByText("1 agent")).toBeInTheDocument();
    expect(screen.getByText("0 agents")).toBeInTheDocument();
    // community + disabled → needs vetting
    expect(screen.getByText("needs vetting")).toBeInTheDocument();
  });

  it("global enabled toggle fires an optimistic PUT patch", () => {
    renderList();
    const toggles = screen.getAllByRole("switch");
    fireEvent.click(toggles[0]!); // sk1 is enabled → toggling sends enabled: false
    expect(updateMutate).toHaveBeenCalledWith({ id: "sk1", patch: { enabled: false } });
  });

  it("search filters client-side by name and by type", () => {
    renderList();
    const input = screen.getByPlaceholderText("Search skills…");
    fireEvent.change(input, { target: { value: "mock-overuse" } });
    expect(screen.queryByText("branch-coverage-rubric")).not.toBeInTheDocument();
    expect(screen.getByText("mock-overuse-gate")).toBeInTheDocument();
    // type match
    fireEvent.change(input, { target: { value: "rubric" } });
    expect(screen.getByText("branch-coverage-rubric")).toBeInTheDocument();
    expect(screen.queryByText("mock-overuse-gate")).not.toBeInTheDocument();
  });
});
