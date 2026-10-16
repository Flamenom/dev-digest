import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { EvalCaseDraft, EvalCaseRecord } from "@devdigest/shared";
import messages from "../../../messages/en/eval.json";

/* The client test harness has no MSW and no QueryClientProvider, so the data
   layer is replaced wholesale by a mutable module-scope state object. */
const state: {
  record: EvalCaseRecord | undefined;
  isLoading: boolean;
  /** The server-composed, UNSAVED draft behind "Turn into eval case" (C24). */
  draft: EvalCaseDraft | undefined;
  draftLoading: boolean;
} = {
  record: undefined,
  isLoading: false,
  draft: undefined,
  draftLoading: false,
};

type MutateOpts<T> = { onSuccess?: (v: T) => void; onError?: (e: unknown) => void };

const createMutate = vi.fn();
const createFromFindingMutate = vi.fn();
/** R8b — runs an UNSAVED case and returns a result without persisting a row. */
const runDraftMutate = vi.fn(
  (
    _vars: { agentId: string; body: unknown },
    opts?: MutateOpts<{
      run_id: string;
      case_id: string;
      result: {
        recall: number;
        precision: number;
        citation_accuracy: number;
        traces_passed: number;
        traces_total: number;
        duration_ms: number;
        cost_usd: number | null;
        per_trace: { name: string; pass: boolean; expected: unknown; actual: unknown }[];
      };
    }>,
  ) =>
    opts?.onSuccess?.({
      run_id: "draft:1",
      case_id: "draft:1",
      result: {
        recall: 1,
        precision: 1,
        citation_accuracy: 1,
        traces_passed: 1,
        traces_total: 1,
        duration_ms: 1800,
        cost_usd: 0.02,
        per_trace: [
          {
            name: "draft",
            pass: true,
            expected: {},
            actual: [{ title: "Hardcoded Stripe secret key", file: "src/config.ts" }],
          },
        ],
      },
    }),
);
const updateMutate = vi.fn();
const runMutate = vi.fn();
/** Answers 409 `case_has_runs` until `force` is set — the server's guard (AC-12). */
const deleteMutate = vi.fn(
  (vars: { caseId: string; force?: boolean }, opts?: MutateOpts<{ deleted: true }>) => {
    if (vars.force) opts?.onSuccess?.({ deleted: true });
    else opts?.onError?.({ status: 409, code: "case_has_runs", details: { run_count: 3 } });
  },
);

vi.mock("@/lib/hooks/eval", () => ({
  useEvalCase: () => ({ data: state.record, isLoading: state.isLoading }),
  useCreateEvalCase: () => ({ mutate: createMutate, isPending: false }),
  useEvalCaseDraft: () => ({ data: state.draft, isLoading: state.draftLoading }),
  useCreateEvalCaseFromFinding: () => ({ mutate: createFromFindingMutate, isPending: false }),
  useRunDraftEvalCase: () => ({ mutate: runDraftMutate, isPending: false }),
  useUpdateEvalCase: () => ({ mutate: updateMutate, isPending: false }),
  useDeleteEvalCase: () => ({ mutate: deleteMutate, isPending: false }),
  useRunEvalCase: () => ({ mutate: runMutate, isPending: false }),
}));

import { EvalCaseEditorModal } from "./EvalCaseEditorModal";

const DIFF = [
  "diff --git a/src/config.ts b/src/config.ts",
  "--- a/src/config.ts",
  "+++ b/src/config.ts",
  "@@ -10,6 +10,7 @@ export const config = {",
  '+  stripeKey: "sk_live_x",',
].join("\n");

const CASE: EvalCaseRecord = {
  id: "case-1",
  owner_kind: "agent",
  owner_id: "agent-1",
  name: "stripe-key-leak",
  input_diff: DIFF,
  input_files: null,
  input_meta: { title: "Add Stripe", body: "Wire payments", number: 42, author: "ada" },
  expected_output: {
    kind: "must_find",
    expectations: [{ file: "src/config.ts", start_line: 12, end_line: 12 }],
  },
  source_finding_id: "finding-7",
  last_run: {
    run_id: "run-1",
    ran_at: "2026-09-01T10:00:00Z",
    pass: false,
    expected_count: 1,
    produced_count: 0,
    duration_ms: 4200,
    cost_usd: 0.01,
  },
  diff_warnings: [],
};

/** A server-composed draft from a DISMISSED finding (C24) — hence must_not_flag. */
const DRAFT: EvalCaseDraft = {
  owner_kind: "agent",
  owner_id: "agent-1",
  name: "stripe-key-leak",
  input_diff: DIFF,
  input_meta: { title: "Add Stripe", body: "Wire payments", number: 42, author: "ada" },
  expected_output: {
    kind: "must_not_flag",
    expectations: [{ file: "src/config.ts", start_line: 12, end_line: 12 }],
  },
  notes: "Created from finding finding-7 on PR #42",
  source_finding_id: "finding-7",
};

afterEach(() => {
  cleanup();
  state.record = undefined;
  state.isLoading = false;
  state.draft = undefined;
  state.draftLoading = false;
  vi.clearAllMocks();
});

function renderModal(props: Partial<React.ComponentProps<typeof EvalCaseEditorModal>> = {}) {
  const onClose = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={{ eval: messages }}>
      <EvalCaseEditorModal caseId="case-1" agentId="agent-1" onClose={onClose} {...props} />
    </NextIntlClientProvider>,
  );
  return onClose;
}

const expectedEditor = () => screen.getByPlaceholderText("Expected output");

/** `@testing-library/user-event` is not a dependency here — the repo's RTL
    tests drive controlled inputs with `fireEvent.change`. */
function setValue(el: HTMLElement, value: string) {
  fireEvent.change(el, { target: { value } });
}

describe("EvalCaseEditorModal", () => {
  it("shows exactly two Input tabs — Diff and PR meta, never Files (§19.1) — and edits both", () => {
    state.record = CASE;
    renderModal({ repoId: "repo-1" });

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Diff" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "PR meta" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /files/i })).not.toBeInTheDocument();

    // The Diff tab is open first and holds the case's pinned diff.
    expect(screen.getByPlaceholderText(/^--- a\/src\/config\.ts/)).toHaveValue(DIFF);

    fireEvent.click(screen.getByRole("button", { name: "PR meta" }));
    expect(screen.getByLabelText("Title")).toHaveValue("Add Stripe");
    expect(screen.getByDisplayValue("Wire payments")).toBeInTheDocument();
  });

  it("AC-14: malformed expected_output shows the invalid badge and disables Save; the skeleton recovers both", () => {
    state.record = CASE;
    renderModal();

    // A valid case opens valid and saveable.
    expect(screen.getByText("valid JSON")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeEnabled();

    setValue(expectedEditor(), "{ kind: nope");

    expect(screen.getByText("invalid JSON")).toBeInTheDocument();
    expect(screen.queryByText("valid JSON")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeDisabled();

    // `+ Finding skeleton` is the way back to a valid one-expectation template.
    fireEvent.click(screen.getByRole("button", { name: "+ Finding skeleton" }));
    expect(screen.getByText("valid JSON")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeEnabled();
  });

  it("AC-13: warns for every must_find range that misses the case's own hunks, and clears once it lands inside", () => {
    state.record = CASE;
    renderModal();

    // Line 12 is inside the only hunk ([10,16]) — no warning yet.
    expect(screen.queryByText(/are not inside any hunk/)).not.toBeInTheDocument();

    setValue(
      expectedEditor(),
      JSON.stringify({
        kind: "must_find",
        expectations: [{ file: "src/config.ts", start_line: 900, end_line: 901 }],
      }),
    );

    expect(
      screen.getByText(
        "Lines 900–901 of src/config.ts are not inside any hunk of this case's diff. " +
          "The grounding gate will drop the correct answer, so recall can never reach 100% on this case.",
      ),
    ).toBeInTheDocument();
    // The JSON is still valid, so the warning does not block Save — it informs.
    expect(screen.getByText("valid JSON")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeEnabled();
  });

  it("saves the edited draft, preserving pinned provenance, and honours the Run-on-save toggle", () => {
    state.record = CASE;
    const onClose = renderModal({ repoId: "repo-1" });

    // Provenance: the deep link is built from input_meta.number, not a uuid.
    expect(screen.getByRole("link", { name: /Created from a judged finding/ })).toHaveAttribute(
      "href",
      "/repos/repo-1/pulls/42?tab=findings&finding=finding-7",
    );
    // Last-run strip.
    expect(screen.getByText("Last run failed")).toBeInTheDocument();
    expect(screen.getByText("expected 1, got 0")).toBeInTheDocument();

    setValue(screen.getByLabelText("Name"), "renamed-case");
    // Q6 — the toggle starts OFF for every modal session.
    const runOnSave = screen.getByRole("switch", { name: "Run on save" });
    expect(runOnSave).toHaveAttribute("aria-checked", "false");
    fireEvent.click(runOnSave);
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    const [vars] = updateMutate.mock.calls[0]!;
    expect(vars.caseId).toBe("case-1");
    expect(vars.patch.name).toBe("renamed-case");
    expect(vars.patch.owner_id).toBe("agent-1");
    expect(vars.patch.input_meta).toEqual({
      title: "Add Stripe",
      body: "Wire payments",
      number: 42,
      author: "ada",
    });
    expect(vars.patch.expected_output).toEqual(CASE.expected_output);
    // No run fired yet — the mutation is mocked and never calls back on success.
    expect(runMutate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // Let the save resolve: run-on-save then fires, and the modal closes.
    const [, opts] = updateMutate.mock.calls[0]!;
    opts.onSuccess({ ...CASE, name: "renamed-case" });
    expect(runMutate).toHaveBeenCalledWith({ caseId: "case-1", agentId: "agent-1" });
    expect(onClose).toHaveBeenCalled();
  });

  it("AC-12: a 409 case_has_runs turns Delete into a confirmation that states the run count", () => {
    state.record = CASE;
    const onClose = renderModal();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteMutate).toHaveBeenCalledWith(
      { caseId: "case-1", agentId: "agent-1", force: false },
      expect.anything(),
    );

    const confirm = screen.getByRole("alert");
    expect(confirm).toHaveTextContent(
      "This case has 3 recorded runs. Deleting it also removes those runs from past batches. Delete anyway?",
    );
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    expect(deleteMutate).toHaveBeenLastCalledWith(
      { caseId: "case-1", agentId: "agent-1", force: true },
      expect.anything(),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("opens a blank, valid, runless editor for a new case and creates it", () => {
    const onClose = renderModal({ caseId: null });

    expect(screen.getByRole("dialog")).toHaveTextContent("New eval case");
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(screen.getByText("valid JSON")).toBeInTheDocument();
    // Nothing to DELETE before the case exists — but "Run case" is offered, and
    // is only disabled because a blank editor has no diff to run yet (R8b).
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run case" })).toBeDisabled();
    // The actual-output panel exists from the start and says so honestly.
    expect(screen.getByLabelText("Actual output")).toHaveTextContent("Never run yet");
    // An empty name is not saveable even though the JSON is valid.
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeDisabled();

    setValue(screen.getByLabelText("Name"), "new-case");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(createMutate).toHaveBeenCalledTimes(1);
    const [body, opts] = createMutate.mock.calls[0]!;
    expect(body).toMatchObject({
      owner_kind: "agent",
      owner_id: "agent-1",
      name: "new-case",
      input_diff: "",
      expected_output: { kind: "must_find", expectations: [] },
    });
    opts.onSuccess({ ...CASE, id: "case-new", name: "new-case" });
    // Run-on-save is off by default, so no model call is triggered.
    expect(runMutate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  /* --- Run case on an UNSAVED draft (R8b) ---------------------------------- */

  it("runs an unsaved case without creating it, and shows what came back", () => {
    state.draft = DRAFT;
    renderModal({ caseId: null, sourceFindingId: "finding-7", prId: "pr-1" });

    fireEvent.click(screen.getByRole("button", { name: "Run case" }));

    // R8b, against the agent the DRAFT names — the PR page never knew it.
    expect(runDraftMutate).toHaveBeenCalledTimes(1);
    const [vars] = runDraftMutate.mock.calls[0]!;
    expect(vars.agentId).toBe("agent-1");
    expect(vars.body).toMatchObject({
      name: "stripe-key-leak",
      expected_output: { kind: "must_not_flag" },
    });

    // Nothing was persisted: no case created, no saved-case run recorded.
    expect(createFromFindingMutate).not.toHaveBeenCalled();
    expect(createMutate).not.toHaveBeenCalled();
    expect(runMutate).not.toHaveBeenCalled();

    // And the result lands in the actual-output panel.
    const actual = screen.getByLabelText("Actual output");
    expect(actual).toHaveTextContent("Hardcoded Stripe secret key");
    expect(actual).not.toHaveTextContent("Never run yet");
  });

  it("states the case kind up front, and follows the finding's judgement", () => {
    // A dismissed finding composes a must_not_flag draft (§7).
    state.draft = DRAFT;
    renderModal({ caseId: null, sourceFindingId: "finding-7" });
    expect(screen.getByRole("dialog")).toHaveTextContent("Negative case");
    expect(screen.getByRole("dialog")).toHaveTextContent("MUST NOT flag the expected location");
    expect(screen.getByRole("dialog")).toHaveTextContent("Seeded from a dismissed finding");

    cleanup();

    // Re-judged the other way → the server composes the other kind, and the
    // banner must follow it rather than a cached first answer.
    state.draft = {
      ...DRAFT,
      expected_output: {
        kind: "must_find",
        expectations: [{ file: "src/config.ts", start_line: 12, end_line: 12 }],
      },
    };
    renderModal({ caseId: null, sourceFindingId: "finding-7" });
    expect(screen.getByRole("dialog")).toHaveTextContent("Positive case");
    expect(screen.getByRole("dialog")).toHaveTextContent("MUST find the expected finding");
  });
});
