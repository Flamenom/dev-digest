import { describe, it, expect, vi } from "vitest";
import { screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { Skill, SkillWithActors } from "@devdigest/shared";
import { renderWithProviders, type RouteRequest, type Routes } from "@/test/render-with-providers";
import { SkillDetail } from "./SkillDetail";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ id: "sk1" }),
  useSearchParams: () => new URLSearchParams(),
}));

// Skip the heavy js-tiktoken encoder — the counter itself isn't under test.
vi.mock("../../../_components/BodyEditor/use-token-count", () => ({
  useTokenCount: (text: string) => text.length,
}));

const SKILL: Skill = {
  id: "sk1",
  name: "branch-coverage-rubric",
  description: "Flags uncovered branches",
  type: "rubric",
  source: "manual",
  body: "# Rubric\nCheck branches.",
  enabled: true,
  version: 2,
  attached_doc_paths: [],
};

/** PUT /skills/sk1 answers with the next version (the server bumps it). */
const ROUTES: Routes = {
  "GET /skills/usage": [],
  "GET /skills/sk1/versions": [],
  "PUT /skills/sk1": (req: RouteRequest) => ({ ...SKILL, ...(req.body as Partial<Skill>), version: 3 }),
};

function renderDetail(skill: SkillWithActors = SKILL, session: "admin" | "member" = "admin") {
  return renderWithProviders(<SkillDetail skill={skill} tab="config" onTab={() => {}} />, {
    session,
    routes: ROUTES,
  });
}

/** Wait until the session resolved to Admin (Save live). */
async function findLiveSave() {
  const save = await screen.findByRole("button", { name: /^Save$/ });
  await waitFor(() => expect(save).not.toHaveAttribute("aria-disabled"));
  return save;
}

const putBody = (router: { calls: RouteRequest[] }) => router.calls.find((c) => c.method === "PUT")?.body;

describe("SkillDetail Config tab", () => {
  it("shows header chips and the body editor chrome without an Evals tab", () => {
    renderDetail();
    expect(screen.getByText("branch-coverage-rubric")).toBeInTheDocument();
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.getByText("branch-coverage-rubric.md")).toBeInTheDocument();
    expect(screen.queryByText(/evals/i)).not.toBeInTheDocument();
    expect(screen.queryByText("unsaved")).not.toBeInTheDocument();
  });

  it("editing the body shows the unsaved chip and save asks for a version note", async () => {
    const { router } = renderDetail();
    const save = await findLiveSave();
    fireEvent.change(screen.getByLabelText("Skill body"), {
      target: { value: "# Rubric\nCheck branches.\nAnd negatives." },
    });
    expect(screen.getByText("unsaved")).toBeInTheDocument();

    fireEvent.click(save);
    // The note mini-modal appears instead of an immediate save.
    const note = screen.getByPlaceholderText("e.g. Tightened the boundary-value checklist");
    fireEvent.change(note, { target: { value: "Added negative-path rule" } });
    fireEvent.click(screen.getByRole("button", { name: /Save version/ }));

    expect(await screen.findByText("Skill saved (v3)")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("e.g. Tightened the boundary-value checklist")).not.toBeInTheDocument();
    expect(putBody(router)).toEqual({
      name: "branch-coverage-rubric",
      description: "Flags uncovered branches",
      type: "rubric",
      body: "# Rubric\nCheck branches.\nAnd negatives.",
      enabled: true,
      note: "Added negative-path rule",
    });
  });

  it("saves directly (no note prompt) when the body is unchanged", async () => {
    const { router } = renderDetail();
    const save = await findLiveSave();
    fireEvent.change(screen.getByDisplayValue("branch-coverage-rubric"), {
      target: { value: "branch-coverage-rubric-v2" },
    });
    fireEvent.click(save);
    expect(await screen.findByText("Skill saved (v3)")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("e.g. Tightened the boundary-value checklist")).not.toBeInTheDocument();
    expect(putBody(router)).toMatchObject({ name: "branch-coverage-rubric-v2" });
    expect(putBody(router)).not.toHaveProperty("note");
  });
});

describe("SkillDetail gating + attribution (AC-33, AC-47/48)", () => {
  it("Member: Save is aria-disabled with an 'Admins only' hint and does nothing; Delete is hidden", async () => {
    const { router } = renderDetail(SKILL, "member");

    const save = await screen.findByRole("button", { name: /^Save$/, description: "Admins only" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(screen.getByLabelText("Skill body"), { target: { value: "changed" } });
    fireEvent.click(save);
    expect(screen.queryByPlaceholderText("e.g. Tightened the boundary-value checklist")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
    expect(router.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("Admin: Save enabled, Delete shown; header names the last updater when the server sends it", async () => {
    renderDetail({ ...SKILL, updated_by: { user_id: "u2", name: "Ann" } });
    await findLiveSave();
    expect(screen.getByRole("button", { name: /Delete/ })).toBeInTheDocument();
    expect(screen.getByText(/Ann/)).toBeInTheDocument();

    // Legacy row (null actor) → "—"; field absent (old server) → no label at all.
    cleanup();
    renderDetail({ ...SKILL, updated_by: null });
    expect(screen.getByText("—")).toBeInTheDocument();
    cleanup();
    renderDetail();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });
});
