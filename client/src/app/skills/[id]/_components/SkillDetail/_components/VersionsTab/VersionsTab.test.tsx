import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Skill, SkillVersionEntry } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/skills.json";
import authMessages from "../../../../../../../../messages/en/auth.json";

// Multi-user gating: drive the session-derived role directly ("admin" =
// today's behaviour, also what local mode resolves to).
const perm = vi.hoisted(() => ({ role: "admin" as "admin" | "member" }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  const current = () =>
    actual.buildPermissions({ mode: "google", role: perm.role, userId: "u1", isPending: false });
  return { ...actual, useCan: current, useIsAdmin: () => current().isAdmin };
});

vi.mock("@/lib/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), toast: vi.fn() }),
}));

const VERSIONS: SkillVersionEntry[] = [
  { skill_id: "sk1", version: 2, note: "Tightened rubric", body: "new body", created_at: "2026-08-18T10:00:00Z" },
  { skill_id: "sk1", version: 1, note: null, body: "old body", created_at: "2026-08-17T10:00:00Z" },
];

const restoreMutate = vi.fn();
vi.mock("@/lib/hooks/skills", () => ({
  useSkillVersions: () => ({ data: VERSIONS, isLoading: false, isError: false, refetch: vi.fn() }),
  useRestoreSkillVersion: () => ({ mutate: restoreMutate, isPending: false }),
}));

import { VersionsTab } from "./VersionsTab";

afterEach(() => {
  cleanup();
  restoreMutate.mockClear();
});

const SKILL: Skill = {
  id: "sk1",
  name: "branch-coverage-rubric",
  description: "d",
  type: "rubric",
  source: "manual",
  body: "new body",
  enabled: true,
  version: 2,
  attached_doc_paths: [],
};

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ skills: messages, auth: authMessages }}>
      <VersionsTab skill={SKILL} />
    </NextIntlClientProvider>,
  );
}

describe("VersionsTab", () => {
  it("lists versions newest-first with note fallback and Current chip", () => {
    renderTab();
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByText("Tightened rubric")).toBeInTheDocument();
    expect(screen.getByText("Body updated")).toBeInTheDocument(); // null-note fallback
    expect(screen.getByText("Current")).toBeInTheDocument();
  });

  it("restore confirms then POSTs the version to /skills/:id/restore", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderTab();
    const restoreButtons = screen.getAllByRole("button", { name: /Restore/ });
    // first row (v2/head) is disabled; second row (v1) is the restorable one
    fireEvent.click(restoreButtons[1]!);
    expect(confirmSpy).toHaveBeenCalled();
    expect(restoreMutate).toHaveBeenCalledTimes(1);
    const [vars] = restoreMutate.mock.calls[0]!;
    expect(vars).toEqual({ id: "sk1", version: 1 });
    confirmSpy.mockRestore();
  });

  it("diff opens a modal with added/removed lines vs the previous version", () => {
    renderTab();
    const diffButtons = screen.getAllByRole("button", { name: /Diff/ });
    fireEvent.click(diffButtons[0]!); // v2 vs v1
    expect(screen.getByText("Diff v1 → v2")).toBeInTheDocument();
    expect(screen.getByText("old body")).toBeInTheDocument();
    expect(screen.getByText("new body")).toBeInTheDocument();
  });
});

describe("VersionsTab gating + version author (AC-33, AC-47/48)", () => {
  afterEach(() => {
    perm.role = "admin";
  });

  it("Member: Restore is aria-disabled with an 'Admins only' hint and never confirms or POSTs; Diff stays usable", () => {
    perm.role = "member";
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderTab();
    const restore = screen.getAllByRole("button", { name: /Restore/ })[1]!;
    expect(restore).toHaveAttribute("aria-disabled", "true");
    expect(restore).toHaveAccessibleDescription("Admins only");
    fireEvent.click(restore);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(restoreMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: /Diff/ })[0]!);
    expect(screen.getByText("Diff v1 → v2")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("names each version's author when present: user name, Local user, or —", () => {
    VERSIONS[0] = { ...VERSIONS[0]!, author: { user_id: "u2", name: "Ann" } } as SkillVersionEntry;
    VERSIONS[1] = { ...VERSIONS[1]!, author: { user_id: "sys", name: "System", is_system: true } } as SkillVersionEntry;
    try {
      renderTab();
      expect(screen.getByText(/Ann/)).toBeInTheDocument();
      expect(screen.getByText(/Local user/)).toBeInTheDocument();
      expect(screen.queryByText("Admins only")).not.toBeInTheDocument();
    } finally {
      for (const v of VERSIONS) delete (v as { author?: unknown }).author;
    }
  });
});
