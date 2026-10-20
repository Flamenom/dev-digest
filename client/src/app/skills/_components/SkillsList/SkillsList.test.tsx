import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import type { Skill } from "@devdigest/shared";
import { renderWithProviders, type RouteRequest } from "@/test/render-with-providers";
import { SkillsList } from "./SkillsList";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useParams: () => ({ id: "sk1" }),
  useSearchParams: () => new URLSearchParams(),
}));

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

/** In-memory skills API: PUT applies the patch, the list re-reads it. */
function skillsApi() {
  let skills = SKILLS;
  return {
    "GET /skills": () => skills,
    "GET /skills/usage": [{ skill_id: "sk1", agents: [{ id: "ag1", name: "Test Quality Reviewer" }] }],
    "PUT /skills/:id": (req: RouteRequest) => {
      skills = skills.map((sk) => (sk.id === req.params.id ? { ...sk, ...(req.body as Partial<Skill>) } : sk));
      return skills.find((sk) => sk.id === req.params.id);
    },
  };
}

beforeEach(() => push.mockReset());

describe("SkillsList", () => {
  it("renders skill cards with usage stat, badges and vetting chip", async () => {
    renderWithProviders(<SkillsList />, { routes: skillsApi() });
    expect(await screen.findByText("branch-coverage-rubric")).toBeInTheDocument();
    expect(screen.getByText("mock-overuse-gate")).toBeInTheDocument();
    expect(await screen.findByText("1 agent")).toBeInTheDocument();
    expect(screen.getByText("0 agents")).toBeInTheDocument();
    // community + disabled → needs vetting
    expect(screen.getByText("needs vetting")).toBeInTheDocument();
  });

  it("the global enabled toggle flips the skill (PUT patch)", async () => {
    const { router } = renderWithProviders(<SkillsList />, { routes: skillsApi() });
    const toggle = await screen.findByRole("switch", { name: "branch-coverage-rubric enabled" });
    await waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled"));

    fireEvent.click(toggle); // sk1 is enabled → toggling sends enabled: false
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "branch-coverage-rubric enabled" })).toHaveAttribute(
        "aria-checked",
        "false",
      ),
    );
    expect(router.calls.find((c) => c.method === "PUT")).toMatchObject({
      path: "/skills/sk1",
      body: { enabled: false },
    });
  });

  it("search filters client-side by name and by type", async () => {
    renderWithProviders(<SkillsList />, { routes: skillsApi() });
    await screen.findByText("branch-coverage-rubric");
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
  it("Member: Add Skill is aria-disabled with an 'Admins only' hint, opens no menu, and the toggles are inert", async () => {
    const { router } = renderWithProviders(<SkillsList />, { session: "member", routes: skillsApi() });

    const add = await screen.findByRole("button", { name: /Add Skill/i, description: "Admins only" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(add);
    expect(screen.queryByText("Create manually")).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalledWith("/skills/new");

    // The list stays readable; the enabled toggles show state but are inert.
    const toggles = await screen.findAllByRole("switch");
    expect(toggles).toHaveLength(2);
    for (const toggle of toggles) {
      expect(toggle).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(toggle);
    }
    expect(screen.getByRole("switch", { name: "branch-coverage-rubric enabled" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(router.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("Admin: Add Skill is enabled with no hint and the toggles are live", async () => {
    renderWithProviders(<SkillsList />, { session: "admin", routes: skillsApi() });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Add Skill/i })).not.toHaveAttribute("aria-disabled"),
    );
    expect(screen.queryByText("Admins only")).not.toBeInTheDocument();
    const toggles = await screen.findAllByRole("switch");
    expect(toggles).toHaveLength(2);
    for (const toggle of toggles) expect(toggle).not.toHaveAttribute("aria-disabled");
  });
});
