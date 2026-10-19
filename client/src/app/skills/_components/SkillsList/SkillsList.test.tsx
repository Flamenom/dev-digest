import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Skill } from "@devdigest/shared";
import messages from "../../../../../messages/en/skills.json";
import authMessages from "../../../../../messages/en/auth.json";

// Multi-user gating: drive the session-derived role directly ("admin" =
// today's behaviour, also what local mode resolves to).
const perm = vi.hoisted(() => ({ role: "admin" as "admin" | "member" }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  const current = () =>
    actual.buildPermissions({ mode: "google", role: perm.role, userId: "u1", isPending: false });
  return { ...actual, useCan: current, useIsAdmin: () => current().isAdmin };
});

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
    <NextIntlClientProvider locale="en" messages={{ skills: messages, auth: authMessages }}>
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

describe("SkillsList gating (AC-33)", () => {
  afterEach(() => {
    perm.role = "admin";
  });

  it("Member: Add Skill is aria-disabled with an 'Admins only' hint, opens no menu, and the enabled toggles are gone", () => {
    perm.role = "member";
    renderList();

    const add = screen.getByRole("button", { name: /Add Skill/i });
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).toHaveAccessibleDescription("Admins only");
    fireEvent.click(add);
    expect(screen.queryByText("Create manually")).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalledWith("/skills/new");

    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    // The list itself stays readable.
    expect(screen.getByText("branch-coverage-rubric")).toBeInTheDocument();
  });

  it("Admin: Add Skill is enabled with no hint and the toggles are shown", () => {
    renderList();
    const add = screen.getByRole("button", { name: /Add Skill/i });
    expect(add).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByText("Admins only")).not.toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(2);
  });
});
