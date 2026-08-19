import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Convention } from "@devdigest/shared";
import conventionsMessages from "../../../../../../../messages/en/conventions.json";
import skillsMessages from "../../../../../../../messages/en/skills.json";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

const toastSuccess = vi.fn();
vi.mock("@/lib/toast", () => ({
  useToast: () => ({ success: toastSuccess, error: vi.fn(), info: vi.fn() }),
}));

const createMutate = vi.fn(
  (
    vars: Record<string, unknown>,
    opts?: { onSuccess?: (s: { id: string; name: string }) => void },
  ) => opts?.onSuccess?.({ id: "sk-new", name: String(vars.name) }),
);
vi.mock("@/lib/hooks/skills", () => ({
  useCreateSkill: () => ({ mutate: createMutate, isPending: false, isError: false }),
}));

import { CreateSkillModal } from "./CreateSkillModal";

afterEach(() => {
  cleanup();
  createMutate.mockClear();
  push.mockClear();
  toastSuccess.mockClear();
});

function convention(overrides: Partial<Convention> = {}): Convention {
  return {
    id: "c1",
    repo_id: "r1",
    category: "error-handling",
    rule: "Always use async/await instead of .then() chains",
    evidence_path: "src/api/users.ts",
    evidence_snippet: "const user = await db.users.find(id);",
    evidence_start_line: 23,
    evidence_end_line: 31,
    confidence: 0.91,
    status: "accepted",
    created_at: "2026-08-19T00:00:00Z",
    ...overrides,
  };
}

const ACCEPTED = [
  convention(),
  convention({ id: "c2", category: "structure", evidence_path: "src/lib/redis.ts", rule: "Redis access goes through the singleton" }),
  convention({ id: "c3", evidence_path: "src/api/users.ts", rule: "Route handlers return typed results" }),
];

function renderModal(onClose = vi.fn()) {
  render(
    <NextIntlClientProvider
      locale="en"
      messages={{ conventions: conventionsMessages, skills: skillsMessages }}
    >
      <CreateSkillModal repoFullName="acme/payments-api" accepted={ACCEPTED} onClose={onClose} />
    </NextIntlClientProvider>,
  );
  return onClose;
}

describe("CreateSkillModal", () => {
  it("prefills name, description, type and the merged body", () => {
    renderModal();
    expect(screen.getByDisplayValue("payments-api-conventions")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("3 house conventions extracted from payments-api"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("convention")).toBeInTheDocument();
    expect(screen.getByText("Create skill from conventions")).toBeInTheDocument();
    const body = screen.getByDisplayValue(/# payments-api-conventions/) as HTMLTextAreaElement;
    expect(body.value).toContain("## redis-access-goes-through-the-singleton");
  });

  it("saves with source 'extracted', enabled toggle state and deduped evidence_files", () => {
    const onClose = renderModal();
    fireEvent.click(screen.getByText("Create skill"));
    expect(createMutate).toHaveBeenCalledTimes(1);
    const vars = createMutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(vars).toMatchObject({
      name: "payments-api-conventions",
      type: "convention",
      enabled: true,
      source: "extracted",
    });
    expect(vars.evidence_files).toEqual(["src/api/users.ts", "src/lib/redis.ts"]);
    expect(toastSuccess).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/skills/sk-new");
  });

  it("cancel closes without creating", () => {
    const onClose = renderModal();
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalled();
    expect(createMutate).not.toHaveBeenCalled();
  });
});
