import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type {
  EvalAgentSummary,
  EvalBatchRecord,
  EvalCaseRecord,
  EvalDashboardOverview,
  EvalRunAllResult,
} from "@devdigest/shared";
import evalMessages from "../../../../../messages/en/eval.json";
import agentMessages from "../../../../../messages/en/agents.json";

/* The client test harness has no MSW and no QueryClientProvider, so the data
   layer is a mutable module-scope state object (the established pattern). */
const state: {
  overview: EvalDashboardOverview | undefined;
  isLoading: boolean;
  isError: boolean;
  runAllData: EvalRunAllResult | undefined;
  caseRecord: EvalCaseRecord | undefined;
} = {
  overview: undefined,
  isLoading: false,
  isError: false,
  runAllData: undefined,
  caseRecord: undefined,
};

const replace = vi.fn();
const searchParams = { value: new URLSearchParams() };
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  useSearchParams: () => searchParams.value,
  useParams: () => ({}),
}));

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const runAllMutate = vi.fn();
vi.mock("@/lib/hooks/eval", () => ({
  useEvalDashboard: () => ({
    data: state.overview,
    isLoading: state.isLoading,
    isError: state.isError,
    refetch: vi.fn(),
  }),
  useRunAllEvals: () => ({
    mutate: runAllMutate,
    isPending: false,
    data: state.runAllData,
  }),
  useEvalCase: () => ({ data: state.caseRecord, isLoading: false }),
  // The deep link always targets an EXISTING case, so the editor never asks
  // for a from-finding draft here.
  useEvalCaseDraft: () => ({ data: undefined, isLoading: false }),
  useCreateEvalCaseFromFinding: () => ({ mutate: vi.fn(), isPending: false }),
  useRunDraftEvalCase: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateEvalCase: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateEvalCase: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteEvalCase: () => ({ mutate: vi.fn(), isPending: false }),
  useRunEvalCase: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { EvalDashboard } from "./EvalDashboard";

afterEach(() => {
  cleanup();
  runAllMutate.mockClear();
  replace.mockClear();
  searchParams.value = new URLSearchParams();
  state.overview = undefined;
  state.isLoading = false;
  state.isError = false;
  state.runAllData = undefined;
  state.caseRecord = undefined;
});

function batch(over: Partial<EvalBatchRecord> = {}): EvalBatchRecord {
  return {
    batch_id: "b1",
    agent_id: "ag1",
    agent_name: "Security Reviewer",
    agent_version: 7,
    ran_at: new Date().toISOString(),
    status: "complete",
    recall: 0.78,
    precision: 0.91,
    citation_accuracy: 1,
    cases_total: 20,
    cases_passed: 17,
    cases_failed: 3,
    cases_errored: 0,
    must_find_total: 14,
    must_find_matched: 11,
    must_not_flag_total: 6,
    noise_findings: 2,
    findings_total: 22,
    grounding_kept: 22,
    grounding_total: 22,
    duration_ms: 42_000,
    cost_usd: 0.128,
    ...over,
  };
}

function agent(over: Partial<EvalAgentSummary> = {}): EvalAgentSummary {
  return {
    agent_id: "ag1",
    name: "Security Reviewer",
    model: "anthropic/claude-opus-4",
    version: 7,
    enabled: true,
    cases_total: 20,
    last_batch: batch(),
    sparkline: [0.6, 0.71, 0.78],
    ...over,
  };
}

function renderDashboard() {
  render(
    <NextIntlClientProvider
      locale="en"
      messages={{ eval: evalMessages, agents: agentMessages }}
    >
      <EvalDashboard />
    </NextIntlClientProvider>,
  );
}

describe("EvalDashboard (/evals overview)", () => {
  it("lists agent row-cards with their latest-batch metrics and the all-agents run table", () => {
    state.overview = {
      agents: [
        agent(),
        agent({
          agent_id: "ag2",
          name: "Test Quality Reviewer",
          model: "openai/gpt-5",
          version: 3,
          cases_total: 4,
          last_batch: batch({
            batch_id: "b2",
            agent_id: "ag2",
            agent_name: "Test Quality Reviewer",
            agent_version: 3,
            recall: null,
            precision: 0.5,
            citation_accuracy: null,
            cases_total: 4,
            cases_passed: 2,
            cases_failed: 2,
            cost_usd: null,
          }),
          sparkline: [],
        }),
      ],
      recent_batches: [batch(), batch({ batch_id: "b2", agent_id: "ag2", agent_name: "Test Quality Reviewer" })],
    };
    renderDashboard();

    // Row-cards: name, model badge, sub-line, metric columns, chevron link.
    const card = screen.getByRole("link", { name: "Security Reviewer" });
    expect(card).toHaveAttribute("href", "/evals/ag1");
    expect(within(card).getByText("anthropic/claude-opus-4")).toBeInTheDocument();
    expect(within(card).getByText(/Last run v7 ·/)).toHaveTextContent("17/20 pass");
    expect(within(card).getByText("78%")).toBeInTheDocument();
    expect(within(card).getByText("91%")).toBeInTheDocument();

    // A null metric renders as an em dash, never as a vacuous 100% (AC-21).
    const second = screen.getByRole("link", { name: "Test Quality Reviewer" });
    expect(within(second).getAllByText("—")).toHaveLength(2);
    expect(within(second).getByText("50%")).toBeInTheDocument();

    // …and the all-agents table lists both batches.
    expect(screen.getByText("Recent eval runs · all agents")).toBeInTheDocument();
    const rows = screen.getAllByRole("row");
    // 1 header + 2 batch rows
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText("Security Reviewer")).toBeInTheDocument();
  });

  it("shows the empty state and disables Run all agents when no agent has cases (AC-20)", () => {
    state.overview = { agents: [], recent_batches: [] };
    renderDashboard();

    expect(screen.getByText("No eval cases")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run all agents/i })).toBeDisabled();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows an agent with zero cases as 'No eval cases' and keeps Run all disabled (AC-20)", () => {
    state.overview = {
      agents: [agent({ cases_total: 0, last_batch: null, sparkline: [] })],
      recent_batches: [],
    };
    renderDashboard();

    const card = screen.getByRole("link", { name: "Security Reviewer" });
    expect(within(card).getByText("No eval cases")).toBeInTheDocument();
    expect(within(card).getAllByText("—")).toHaveLength(3);
    expect(screen.getByRole("button", { name: /run all agents/i })).toBeDisabled();
  });

  it("shows a progress indicator instead of metric values while a batch runs (AC-22)", () => {
    const running = batch({
      status: "running",
      cases_passed: 5,
      cases_failed: 2,
      cases_errored: 0,
      recall: 0.99,
      precision: 0.99,
      citation_accuracy: 0.99,
    });
    state.overview = {
      agents: [agent({ last_batch: running })],
      recent_batches: [running],
    };
    renderDashboard();

    // Both the row-card and the table row swap numbers for progress.
    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect(bar).toHaveAttribute("aria-valuenow", "7");
      expect(bar).toHaveAttribute("aria-valuemax", "20");
    }
    expect(screen.getAllByText("7/20").length).toBeGreaterThan(0);
    // The partial metrics of a running batch are never displayed.
    expect(screen.queryByText("99%")).not.toBeInTheDocument();
  });

  it("runs all agents and explains every skipped one (AC-34)", () => {
    state.overview = { agents: [agent()], recent_batches: [] };
    renderDashboard();

    fireEvent.click(screen.getByRole("button", { name: /run all agents/i }));
    expect(runAllMutate).toHaveBeenCalledTimes(1);

    cleanup();
    state.runAllData = {
      started: [{ batch_id: "b9", agent_id: "ag1", agent_version: 7, cases_total: 20 }],
      skipped: [
        { agent_id: "ag2", agent_name: "Test Quality Reviewer", reason: "no_cases" },
        { agent_id: "ag3", agent_name: "Perf Reviewer", reason: "already_running" },
        { agent_id: "ag4", agent_name: "Docs Reviewer", reason: "disabled" },
      ],
    };
    renderDashboard();

    const summary = screen.getByRole("status");
    expect(within(summary).getByText("Test Quality Reviewer")).toBeInTheDocument();
    expect(within(summary).getByText("No eval cases")).toBeInTheDocument();
    expect(within(summary).getByText(/a batch is already running/i)).toBeInTheDocument();
    expect(within(summary).getByText("Perf Reviewer")).toBeInTheDocument();
    expect(within(summary).getByText("disabled")).toBeInTheDocument();
  });

  it("opens the case editor for ?case=<uuid> and clears the param on close", () => {
    state.overview = { agents: [agent()], recent_batches: [] };
    state.caseRecord = {
      id: "case-1",
      owner_kind: "agent",
      owner_id: "ag1",
      name: "stripe-key-leak",
      input_diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n+x\n",
      input_files: null,
      input_meta: {},
      expected_output: { kind: "must_find", expectations: [] },
      source_finding_id: "f1",
      diff_warnings: [],
    };
    searchParams.value = new URLSearchParams("case=case-1");
    renderDashboard();

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByDisplayValue("stripe-key-leak")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    // useQueryParam removes the key by rewriting the URL through router.replace.
    expect(replace).toHaveBeenCalled();
    expect(String(replace.mock.calls[0]![0])).not.toContain("case=case-1");
  });
});
