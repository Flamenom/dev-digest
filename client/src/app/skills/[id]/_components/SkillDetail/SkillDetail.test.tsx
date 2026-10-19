import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Skill } from "@devdigest/shared";
import messages from "../../../../../../messages/en/skills.json";
import authMessages from "../../../../../../messages/en/auth.json";

// Multi-user gating: drive the session-derived role directly ("admin" =
// today's behaviour, also what local mode resolves to).
const perm = vi.hoisted(() => ({ role: "admin" as "admin" | "member" }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  const current = () =>
    actual.buildPermissions({ mode: "google", role: perm.role, userId: "u1", isPending: false });
  return { ...actual, useCan: current, useIsAdmin: () => current().isAdmin };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ id: "sk1" }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), toast: vi.fn() }),
}));

// Skip the heavy js-tiktoken encoder — the counter itself isn't under test.
vi.mock("../../../_components/BodyEditor/use-token-count", () => ({
  useTokenCount: (text: string) => text.length,
}));

const updateMutate = vi.fn(
  (
    vars: { id: string; patch: Record<string, unknown> },
    opts?: { onSuccess?: (d: unknown) => void },
  ) => opts?.onSuccess?.({ id: vars.id, version: 3 }),
);

vi.mock("@/lib/hooks/skills", () => ({
  useUpdateSkill: () => ({ mutate: updateMutate, isPending: false }),
  useDeleteSkill: () => ({ mutate: vi.fn(), isPending: false }),
  useSkillsUsage: () => ({ data: [] }),
  useSkillStats: () => ({ data: undefined }),
  useSkillVersions: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
  useRestoreSkillVersion: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { SkillDetail } from "./SkillDetail";

afterEach(() => {
  cleanup();
  updateMutate.mockClear();
});

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

function renderDetail(tab = "config") {
  return render(
    <NextIntlClientProvider locale="en" messages={{ skills: messages, auth: authMessages }}>
      <SkillDetail skill={SKILL} tab={tab} onTab={() => {}} />
    </NextIntlClientProvider>,
  );
}

describe("SkillDetail Config tab", () => {
  it("shows header chips and the body editor chrome without an Evals tab", () => {
    renderDetail();
    expect(screen.getByText("branch-coverage-rubric")).toBeInTheDocument();
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.getByText("branch-coverage-rubric.md")).toBeInTheDocument();
    expect(screen.queryByText(/evals/i)).not.toBeInTheDocument();
    expect(screen.queryByText("unsaved")).not.toBeInTheDocument();
  });

  it("editing the body shows the unsaved chip and save asks for a version note", () => {
    renderDetail();
    const body = screen.getByLabelText("Skill body");
    fireEvent.change(body, { target: { value: "# Rubric\nCheck branches.\nAnd negatives." } });
    expect(screen.getByText("unsaved")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    // note mini-modal appears instead of an immediate PUT
    expect(updateMutate).not.toHaveBeenCalled();
    const note = screen.getByPlaceholderText("e.g. Tightened the boundary-value checklist");
    fireEvent.change(note, { target: { value: "Added negative-path rule" } });
    fireEvent.click(screen.getByRole("button", { name: /Save version/ }));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    const [vars] = updateMutate.mock.calls[0]!;
    expect(vars).toEqual({
      id: "sk1",
      patch: {
        name: "branch-coverage-rubric",
        description: "Flags uncovered branches",
        type: "rubric",
        body: "# Rubric\nCheck branches.\nAnd negatives.",
        enabled: true,
        note: "Added negative-path rule",
      },
    });
  });

  it("saves directly (no note prompt) when the body is unchanged", () => {
    renderDetail();
    const name = screen.getByDisplayValue("branch-coverage-rubric");
    fireEvent.change(name, { target: { value: "branch-coverage-rubric-v2" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(updateMutate).toHaveBeenCalledTimes(1);
    const [vars] = updateMutate.mock.calls[0]!;
    expect(vars.patch).not.toHaveProperty("note");
    expect(vars.patch.name).toBe("branch-coverage-rubric-v2");
  });
});

describe("SkillDetail gating + attribution (AC-33, AC-47/48)", () => {
  afterEach(() => {
    perm.role = "admin";
  });

  it("Member: Save is aria-disabled with an 'Admins only' hint and does nothing; Delete is hidden", () => {
    perm.role = "member";
    renderDetail();

    const save = screen.getByRole("button", { name: /^Save$/ });
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(save).toHaveAccessibleDescription("Admins only");
    fireEvent.change(screen.getByLabelText("Skill body"), { target: { value: "changed" } });
    fireEvent.click(save);
    expect(updateMutate).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText("e.g. Tightened the boundary-value checklist")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
  });

  it("Admin: Save enabled, Delete shown; header names the last updater when the server sends it", () => {
    render(
      <NextIntlClientProvider locale="en" messages={{ skills: messages, auth: authMessages }}>
        <SkillDetail
          skill={{ ...SKILL, updated_by: { user_id: "u2", name: "Ann" } }}
          tab="config"
          onTab={() => {}}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("button", { name: /^Save$/ })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("button", { name: /Delete/ })).toBeInTheDocument();
    expect(screen.getByText(/Ann/)).toBeInTheDocument();

    // Legacy row (null actor) → "—"; field absent (old server) → no label at all.
    cleanup();
    render(
      <NextIntlClientProvider locale="en" messages={{ skills: messages, auth: authMessages }}>
        <SkillDetail skill={{ ...SKILL, updated_by: null }} tab="config" onTab={() => {}} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
    cleanup();
    renderDetail();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });
});
