import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Skill, SkillVersionEntry } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/skills.json";

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
    <NextIntlClientProvider locale="en" messages={{ skills: messages }}>
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
