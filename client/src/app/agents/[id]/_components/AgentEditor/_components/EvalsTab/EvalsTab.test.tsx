import { describe, it, expect } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  Agent,
  EvalAgentDashboard,
  EvalBatchRecord,
  EvalBatchStarted,
  EvalCaseRecordWithActor,
  EvalCaseRunRecord,
} from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/eval.json";
import {
  apiError,
  renderWithProviders,
  sessionFor,
  type RouteRequest,
  type Routes,
} from "@/test/render-with-providers";
import { EvalsTab } from "./EvalsTab";

/** 202 + `batch_id` — the tab stores it and starts merging that batch's rows. */
const STARTED: EvalBatchStarted = {
  batch_id: "batch-1",
  agent_id: "ag1",
  agent_version: 7,
  cases_total: 2,
};

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

const evalCase = (
  id: string,
  name: string,
  over: Partial<EvalCaseRecordWithActor> = {},
): EvalCaseRecordWithActor => ({
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

interface EvalsApi {
  cases?: EvalCaseRecordWithActor[];
  dashboard?: EvalAgentDashboard;
  /** Rows of the started batch (served once the tab asks for `batch_id`). */
  runs?: EvalCaseRunRecord[];
  extra?: Routes;
}

function evalsApi({ cases = [], dashboard: dash = dashboard([]), runs = [], extra = {} }: EvalsApi): Routes {
  return {
    "GET /agents/ag1/eval-cases": cases,
    "GET /agents/ag1/eval-dashboard": dash,
    "GET /agents/ag1/eval-runs": (req: RouteRequest) => (req.query.get("batch_id") === STARTED.batch_id ? runs : []),
    "POST /agents/ag1/eval-runs": STARTED,
    "POST /eval-cases/:id/run": (req: RouteRequest) => ({ case_id: req.params.id }),
    ...extra,
  };
}

function renderTab(api: EvalsApi = {}, session = sessionFor("admin")) {
  return renderWithProviders(<EvalsTab agent={AGENT} />, { session, routes: evalsApi(api) });
}

function rowNamed(name: string): HTMLElement {
  const row = screen.getAllByRole("listitem").find((li) => within(li).queryByText(name));
  if (!row) throw new Error(`no row ${name}`);
  return row;
}

describe("AgentEditor Evals tab (screen E)", () => {
  it("disables the Run control and explains the empty set when the agent has no cases (AC-20)", async () => {
    renderTab({ dashboard: dashboard([]) });

    // AC-20 — the client half: Run disabled + an empty-state message.
    expect(await screen.findByText(/No eval cases yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Run all evals/i })).toBeDisabled();
    expect(screen.getByText("0 / 0 passing")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);

    // No batch has ever run, so no metric may be shown as a number (AC-21).
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(await screen.findByText(/No runs yet/i)).toBeInTheDocument();
  });

  it("flips each case row to its own result as the batch finishes (§19.6)", async () => {
    const user = userEvent.setup();
    const { router } = renderTab({
      dashboard: dashboard([BATCH]),
      cases: [
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
      ],
      // The batch's rows: case-1 already finished and passed, case-2 still pending.
      runs: [
        runRow("case-1", { actual_output: { findings: [{ id: "f1" }] }, pass: true, recall: 1 }),
        runRow("case-2"),
      ],
    });

    // Before the batch starts the rows show the persisted `last_run` strip.
    await screen.findAllByRole("listitem");
    expect(within(rowNamed("stripe-key-leak")).getByRole("img", { name: "failed" })).toBeInTheDocument();
    expect(within(rowNamed("stripe-key-leak")).getByText(/expected 1, got none/i)).toBeInTheDocument();
    expect(within(rowNamed("clean-refactor-no-flags")).getByText(/never run/i)).toBeInTheDocument();
    expect(screen.getByText("0 / 2 passing")).toBeInTheDocument();
    // Kind badges come from `expected_output.kind`, not from the run.
    expect(within(rowNamed("stripe-key-leak")).getByText("must find")).toBeInTheDocument();
    expect(within(rowNamed("clean-refactor-no-flags")).getByText("must not flag")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Run all evals/i }));

    // …and now each row reads the batch row for its own case.
    expect(await within(rowNamed("stripe-key-leak")).findByRole("img", { name: "passed" })).toBeInTheDocument();
    const finished = rowNamed("stripe-key-leak");
    expect(within(finished).getByText(/expected 1, got 1/i)).toBeInTheDocument();
    expect(within(finished).getByText(/recall 100%/i)).toBeInTheDocument();

    const pending = rowNamed("clean-refactor-no-flags");
    expect(within(pending).getByRole("img", { name: "Running…" })).toBeInTheDocument();
    expect(within(pending).getByText("Running…")).toBeInTheDocument();

    // Progress and the pill both track the live rows, not the stale last runs.
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByText("1 / 2 passing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Running…/i })).toBeDisabled();
    expect(router.calls.find((c) => c.method === "POST")?.path).toBe("/agents/ag1/eval-runs");
  });

  it("a failed batch start is explained inline only — no global toast on top", async () => {
    const user = userEvent.setup();
    renderTab({
      cases: [evalCase("case-1", "stripe-key-leak")],
      extra: {
        "POST /agents/ag1/eval-runs": () => apiError(409, "batch_already_running", "raw server text"),
      },
    });

    const run = await screen.findByRole("button", { name: /Run all evals/i });
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);
    expect(await screen.findByRole("alert")).toHaveTextContent(messages.errors.batchAlreadyRunning);
    expect(screen.queryByText("raw server text")).not.toBeInTheDocument();
  });

  it("links to the full dashboard and reads its metric tiles from the latest complete batch", async () => {
    renderTab({ dashboard: dashboard([BATCH]), cases: [evalCase("case-1", "stripe-key-leak")] });

    expect(await screen.findByText("80%")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View full dashboard/i })).toHaveAttribute("href", "/evals/ag1");
    expect(screen.getByText("90%")).toBeInTheDocument();
    expect(screen.getByText("$0.0123")).toBeInTheDocument();
    expect(screen.getByText(/1 \/ 2 cases passed/i)).toBeInTheDocument();
  });
});

/* AC-30 / AC-33: Members run evals and author cases; Edit / Delete appear only
   on cases they created. A legacy case (no recorded creator) is Admin-only. */
describe("AgentEditor Evals tab — eval-case ownership (AC-30)", () => {
  const CASES = [
    evalCase("case-own", "own-case", { created_by: { user_id: "u-a", name: "Ada" } }),
    evalCase("case-other", "others-case", { created_by: { user_id: "u-b", name: "Bob" } }),
    evalCase("case-legacy", "legacy-case", { created_by: null }),
  ];

  it("Member: Edit/Delete only on their own case; Run, Run all and New case stay enabled", async () => {
    const user = userEvent.setup();
    const { router } = renderTab({ cases: CASES }, sessionFor("member", { userId: "u-a" }));

    await screen.findAllByRole("listitem");
    const own = rowNamed("own-case");
    expect(await within(own).findByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(own).getByRole("button", { name: "Delete" })).toBeInTheDocument();

    for (const name of ["others-case", "legacy-case"]) {
      const row = rowNamed(name);
      expect(within(row).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
      expect(within(row).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
      expect(within(row).getByRole("button", { name: "Run" })).toBeInTheDocument();
    }

    await user.click(within(rowNamed("others-case")).getByRole("button", { name: "Run" }));
    // A single-case run has no visible outcome on this tab (results land on the
    // next case-list read), so the request itself is the only observable signal.
    await waitFor(() => expect(router.calls.some((c) => c.path === "/eval-cases/case-other/run")).toBe(true));
    expect(screen.getByRole("button", { name: /Run all evals/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /New case/i })).toBeEnabled();
  });

  it("Admin: Edit/Delete on every case, including the legacy one", async () => {
    renderTab({ cases: CASES }, sessionFor("admin"));

    await screen.findAllByRole("listitem");
    await within(rowNamed("legacy-case")).findByRole("button", { name: "Edit" });
    for (const name of ["own-case", "others-case", "legacy-case"]) {
      const row = rowNamed(name);
      expect(within(row).getByRole("button", { name: "Edit" })).toBeInTheDocument();
      expect(within(row).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    }
  });
});
