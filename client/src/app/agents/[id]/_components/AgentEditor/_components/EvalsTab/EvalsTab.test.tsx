import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type {
  Agent,
  EvalAgentDashboard,
  EvalBatchRecord,
  EvalBatchStarted,
  EvalCaseRecord,
  EvalCaseRunRecord,
} from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/eval.json";

/* The client test harness has no MSW and no QueryClientProvider, so the whole
   eval data layer is replaced by a mutable module-scope state object. */
const state: {
  cases: EvalCaseRecord[];
  dashboard: EvalAgentDashboard | undefined;
  runs: EvalCaseRunRecord[];
  casesLoading: boolean;
} = { cases: [], dashboard: undefined, runs: [], casesLoading: false };

type MutateOpts<T> = { onSuccess?: (v: T) => void; onError?: (e: unknown) => void };

const STARTED: EvalBatchStarted = {
  batch_id: "batch-1",
  agent_id: "ag1",
  agent_version: 7,
  cases_total: 2,
};

/** 202 + `batch_id` — the tab stores it and starts merging that batch's rows. */
const startMutate = vi.fn((_v: unknown, opts?: MutateOpts<EvalBatchStarted>) => opts?.onSuccess?.(STARTED));
const runCaseMutate = vi.fn();
const deleteMutate = vi.fn();

vi.mock("@/lib/hooks/eval", () => ({
  useAgentEvalCases: () => ({ data: state.cases, isLoading: state.casesLoading }),
  useAgentEvalDashboard: () => ({ data: state.dashboard, isLoading: false }),
  useAgentEvalRuns: () => ({ data: state.runs }),
  useStartEvalBatch: () => ({ mutate: startMutate, isPending: false }),
  useRunEvalCase: () => ({ mutate: runCaseMutate, isPending: false }),
  useDeleteEvalCase: () => ({ mutate: deleteMutate, isPending: false }),
  // Reached only when the case-editor modal opens (T22 owns its own tests).
  useEvalCase: () => ({ data: undefined, isLoading: false }),
  useCreateEvalCase: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateEvalCase: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { EvalsTab } from "./EvalsTab";

const AGENT: Agent = {
  id: "ag1",
  name: "Security Reviewer",
  description: "Flags secrets and injection",
  provider: "openai",
  model: "gpt-4.1",
  system_prompt: "You are a security reviewer.",
  output_schema: null,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
  enabled: true,
  version: 7,
  attached_doc_paths: [],
};

const evalCase = (id: string, name: string, over: Partial<EvalCaseRecord> = {}): EvalCaseRecord => ({
  id,
  owner_kind: "agent",
  owner_id: "ag1",
  name,
  input_diff: "diff --git a/src/config.ts b/src/config.ts",
  input_files: null,
  input_meta: { title: "Add Stripe" },
  expected_output: {
    kind: "must_find",
    expectations: [{ file: "src/config.ts", start_line: 12, end_line: 12 }],
  },
  source_finding_id: null,
  last_run: null,
  diff_warnings: [],
  ...over,
});

const BATCH: EvalBatchRecord = {
  batch_id: "batch-0",
  agent_id: "ag1",
  agent_name: "Security Reviewer",
  agent_version: 6,
  ran_at: "2026-09-01T10:00:00Z",
  status: "complete",
  recall: 0.8,
  precision: 0.9,
  citation_accuracy: 1,
  cases_total: 2,
  cases_passed: 1,
  cases_failed: 1,
  cases_errored: 0,
  must_find_total: 1,
  must_find_matched: 1,
  must_not_flag_total: 1,
  noise_findings: 0,
  findings_total: 3,
  grounding_kept: 3,
  grounding_total: 3,
  duration_ms: 4200,
  cost_usd: 0.0123,
};

const dashboard = (batches: EvalBatchRecord[]): EvalAgentDashboard => ({
  agent: { id: "ag1", name: "Security Reviewer", model: "gpt-4.1", version: 7, provider: "openai" },
  window_days: 30,
  dashboard: {
    owner_kind: "agent",
    owner_id: "ag1",
    cases_total: 2,
    current: { recall: 0.8, precision: 0.9, citation_accuracy: 1, traces_passed: 1, traces_total: 2, cost_usd: 0.0123 },
    delta: { recall: 0, precision: 0, citation_accuracy: 0 },
    trend: [],
    recent_runs: [],
    alert: null,
  },
  batches,
  alert: null,
});

const runRow = (caseId: string, over: Partial<EvalCaseRunRecord> = {}): EvalCaseRunRecord => ({
  id: `run-${caseId}`,
  case_id: caseId,
  case_name: caseId,
  ran_at: "2026-09-02T10:00:00Z",
  actual_output: null,
  pass: null,
  recall: null,
  precision: null,
  citation_accuracy: null,
  duration_ms: null,
  cost_usd: null,
  batch_id: "batch-1",
  agent_version: 7,
  ...over,
});

afterEach(() => {
  cleanup();
  state.cases = [];
  state.dashboard = undefined;
  state.runs = [];
  state.casesLoading = false;
  vi.clearAllMocks();
});

function renderTab() {
  render(
    <NextIntlClientProvider locale="en" messages={{ eval: messages }}>
      <EvalsTab agent={AGENT} />
    </NextIntlClientProvider>,
  );
}

const rowNamed = (name: string) =>
  screen.getAllByRole("listitem").find((li) => within(li).queryByText(name))!;

describe("AgentEditor Evals tab (screen E)", () => {
  it("disables the Run control and explains the empty set when the agent has no cases (AC-20)", () => {
    state.dashboard = dashboard([]);
    renderTab();

    // AC-20 — the client half: Run disabled + an empty-state message.
    expect(screen.getByRole("button", { name: /Run all evals/i })).toBeDisabled();
    expect(screen.getByText(/No eval cases yet/i)).toBeInTheDocument();
    expect(screen.getByText("0 / 0 passing")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);

    // No batch has ever run, so no metric may be shown as a number (AC-21).
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getByText(/No runs yet/i)).toBeInTheDocument();
  });

  it("flips each case row to its own result as the batch finishes (§19.6)", () => {
    state.dashboard = dashboard([BATCH]);
    state.cases = [
      evalCase("case-1", "stripe-key-leak", {
        last_run: {
          run_id: "run-old",
          ran_at: "2026-09-01T10:00:00Z",
          pass: false,
          expected_count: 1,
          produced_count: 0,
          duration_ms: 3000,
          cost_usd: 0.01,
        },
      }),
      evalCase("case-2", "clean-refactor-no-flags", {
        expected_output: { kind: "must_not_flag", expectations: [{ file: "src/a.ts", start_line: 4 }] },
      }),
    ];
    // The batch's rows: case-1 already finished and passed, case-2 still pending.
    state.runs = [
      runRow("case-1", { actual_output: { findings: [{ id: "f1" }] }, pass: true, recall: 1 }),
      runRow("case-2"),
    ];

    renderTab();

    // Before the batch starts the rows show the persisted `last_run` strip.
    expect(within(rowNamed("stripe-key-leak")).getByRole("img", { name: "failed" })).toBeInTheDocument();
    expect(within(rowNamed("stripe-key-leak")).getByText(/expected 1, got none/i)).toBeInTheDocument();
    expect(within(rowNamed("clean-refactor-no-flags")).getByText(/never run/i)).toBeInTheDocument();
    expect(screen.getByText("0 / 2 passing")).toBeInTheDocument();
    // Kind badges come from `expected_output.kind`, not from the run.
    expect(within(rowNamed("stripe-key-leak")).getByText("must find")).toBeInTheDocument();
    expect(within(rowNamed("clean-refactor-no-flags")).getByText("must not flag")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Run all evals/i }));
    expect(startMutate).toHaveBeenCalledWith({ agentId: "ag1" }, expect.anything());

    // …and now each row reads the batch row for its own case.
    const finished = rowNamed("stripe-key-leak");
    expect(within(finished).getByRole("img", { name: "passed" })).toBeInTheDocument();
    expect(within(finished).getByText(/expected 1, got 1/i)).toBeInTheDocument();
    expect(within(finished).getByText(/recall 100%/i)).toBeInTheDocument();

    const pending = rowNamed("clean-refactor-no-flags");
    expect(within(pending).getByRole("img", { name: "Running…" })).toBeInTheDocument();
    expect(within(pending).getByText("Running…")).toBeInTheDocument();

    // Progress and the pill both track the live rows, not the stale last runs.
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByText("1 / 2 passing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Running…/i })).toBeDisabled();
  });

  it("links to the full dashboard and reads its metric tiles from the latest complete batch", () => {
    state.dashboard = dashboard([BATCH]);
    state.cases = [evalCase("case-1", "stripe-key-leak")];
    renderTab();

    expect(screen.getByRole("link", { name: /View full dashboard/i })).toHaveAttribute("href", "/evals/ag1");
    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(screen.getByText("90%")).toBeInTheDocument();
    expect(screen.getByText("$0.0123")).toBeInTheDocument();
    expect(screen.getByText(/1 \/ 2 cases passed/i)).toBeInTheDocument();
  });
});
