import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Convention } from "@devdigest/shared";
import messages from "../../../../../../../messages/en/conventions.json";

const updateMutate = vi.fn();
vi.mock("@/lib/hooks/conventions", () => ({
  useUpdateConvention: () => ({ mutate: updateMutate, isPending: false }),
}));

import { ConventionCard } from "./ConventionCard";

afterEach(() => {
  cleanup();
  updateMutate.mockClear();
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
    status: "pending",
    created_at: "2026-08-19T00:00:00Z",
    ...overrides,
  };
}

function renderCard(c: Convention) {
  render(
    <NextIntlClientProvider locale="en" messages={{ conventions: messages }}>
      <ConventionCard convention={c} repoId="r1" />
    </NextIntlClientProvider>,
  );
}

describe("ConventionCard", () => {
  it("renders rule, category, evidence label, snippet and confidence", () => {
    renderCard(convention());
    expect(screen.getByText("Always use async/await instead of .then() chains")).toBeInTheDocument();
    expect(screen.getByText("error-handling")).toBeInTheDocument();
    expect(screen.getByText("src/api/users.ts:23-31")).toBeInTheDocument();
    expect(screen.getByText("const user = await db.users.find(id);")).toBeInTheDocument();
    expect(screen.getByText("91%")).toBeInTheDocument();
  });

  it("Accept fires a status mutation; clicking the active state toggles back to pending", () => {
    renderCard(convention());
    fireEvent.click(screen.getByText("Accept"));
    expect(updateMutate).toHaveBeenCalledWith({ id: "c1", patch: { status: "accepted" } });

    cleanup();
    updateMutate.mockClear();
    renderCard(convention({ status: "accepted" }));
    fireEvent.click(screen.getByText("Accepted"));
    expect(updateMutate).toHaveBeenCalledWith({ id: "c1", patch: { status: "pending" } });
  });

  it("Reject fires a rejected mutation", () => {
    renderCard(convention());
    fireEvent.click(screen.getByText("Reject"));
    expect(updateMutate).toHaveBeenCalledWith({ id: "c1", patch: { status: "rejected" } });
  });

  it("inline edit saves a trimmed rule patch", () => {
    renderCard(convention());
    fireEvent.click(screen.getByLabelText("Edit rule"));
    const input = screen.getByDisplayValue("Always use async/await instead of .then() chains");
    fireEvent.change(input, { target: { value: "  Prefer async/await  " } });
    fireEvent.click(screen.getByText("Save"));
    expect(updateMutate).toHaveBeenCalledWith({ id: "c1", patch: { rule: "Prefer async/await" } });
  });

  it("cancel restores the original rule without mutating", () => {
    renderCard(convention());
    fireEvent.click(screen.getByLabelText("Edit rule"));
    const input = screen.getByDisplayValue("Always use async/await instead of .then() chains");
    fireEvent.change(input, { target: { value: "changed" } });
    fireEvent.click(screen.getByText("Cancel"));
    expect(updateMutate).not.toHaveBeenCalled();
    expect(screen.getByText("Always use async/await instead of .then() chains")).toBeInTheDocument();
  });
});
