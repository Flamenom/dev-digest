import { describe, it, expect, afterEach, vi } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  EvalAgentSummary,
  EvalBatchRecord,
  EvalCaseRecord,
  EvalDashboardOverview,
  EvalRunAllResult,
} from "@devdigest/shared";
import { renderWithProviders, type Routes } from "@/test/render-with-providers";
import { EvalDashboard } from "./EvalDashboard";

const replace = vi.fn();
const searchParams = { value: new URLSearchParams() };
vi.mock("next/navigation", () => ({
  usePathname: () => "/evals",
  useRouter: () => ({ push: vi.fn(), replace }),
  useSearchParams: () => searchParams.value,
  useParams: () => ({}),
}));

afterEach(() => {
  replace.mockClear();
  searchParams.value = new URLSearchParams();
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

function renderDashboard(overview: EvalDashboardOverview, extra: Routes = {}) {
  return renderWithProviders(<EvalDashboard />, {
    routes: { "GET /evals/dashboard": overview, ...extra },
  });
}

/** The Run-all summary (the toast region is a `status` too, named "Notifications"). */
async function findRunAllSummary(): Promise<HTMLElement> {
  let summary: HTMLElement | undefined;
  await waitFor(() => {
    summary = screen.getAllByRole("status").find((el) => el.getAttribute("aria-label") !== "Notifications");
    expect(summary).toBeDefined();
  });
  if (!summary) throw new Error("no run-all summary");
  return summary;
}

describe("EvalDashboard (/evals overview)", () => {
  it("lists agent row-cards with their latest-batch metrics and the all-agents run table", async () => {
    renderDashboard({
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
    });

    // Row-cards: name, model badge, sub-line, metric columns, chevron link.
    const card = await screen.findByRole("link", { name: "Security Reviewer" });
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
    const [, firstBatchRow, ...others] = within(screen.getByRole("table")).getAllByRole("row");
    // 1 header + 2 batch rows
    expect(others).toHaveLength(1);
    if (!firstBatchRow) throw new Error("no batch row");
    expect(within(firstBatchRow).getByText("Security Reviewer")).toBeInTheDocument();
  });

  it("shows the empty state and disables Run all agents when no agent has cases (AC-20)", async () => {
    renderDashboard({ agents: [], recent_batches: [] });

    expect(await screen.findByText("No eval cases")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run all agents/i })).toBeDisabled();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows an agent with zero cases as 'No eval cases' and keeps Run all disabled (AC-20)", async () => {
    renderDashboard({ agents: [agent({ cases_total: 0, last_batch: null, sparkline: [] })], recent_batches: [] });

    const card = await screen.findByRole("link", { name: "Security Reviewer" });
    expect(within(card).getByText("No eval cases")).toBeInTheDocument();
    expect(within(card).getAllByText("—")).toHaveLength(3);
    expect(screen.getByRole("button", { name: /run all agents/i })).toBeDisabled();
  });

  it("shows a progress indicator instead of metric values while a batch runs (AC-22)", async () => {
    const running = batch({
      status: "running",
      cases_passed: 5,
      cases_failed: 2,
      cases_errored: 0,
      recall: 0.99,
      precision: 0.99,
      citation_accuracy: 0.99,
    });
    renderDashboard({ agents: [agent({ last_batch: running })], recent_batches: [running] });

    // Both the row-card and the table row swap numbers for progress.
    const bars = await screen.findAllByRole("progressbar");
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect(bar).toHaveAttribute("aria-valuenow", "7");
      expect(bar).toHaveAttribute("aria-valuemax", "20");
    }
    expect(screen.getAllByText("7/20").length).toBeGreaterThan(0);
    // The partial metrics of a running batch are never displayed.
    expect(screen.queryByText("99%")).not.toBeInTheDocument();
  });

  it("runs all agents and explains every skipped one (AC-34)", async () => {
    const user = userEvent.setup();
    const result: EvalRunAllResult = {
      started: [{ batch_id: "b9", agent_id: "ag1", agent_version: 7, cases_total: 20 }],
      skipped: [
        { agent_id: "ag2", agent_name: "Test Quality Reviewer", reason: "no_cases" },
        { agent_id: "ag3", agent_name: "Perf Reviewer", reason: "already_running" },
        { agent_id: "ag4", agent_name: "Docs Reviewer", reason: "disabled" },
      ],
    };
    renderDashboard({ agents: [agent()], recent_batches: [] }, { "POST /evals/run-all": result });

    const runAll = await screen.findByRole("button", { name: /run all agents/i });
    await waitFor(() => expect(runAll).toBeEnabled());
    await user.click(runAll);

    const summary = await findRunAllSummary();
    expect(within(summary).getByText("Test Quality Reviewer")).toBeInTheDocument();
    expect(within(summary).getByText("No eval cases")).toBeInTheDocument();
    expect(within(summary).getByText(/a batch is already running/i)).toBeInTheDocument();
    expect(within(summary).getByText("Perf Reviewer")).toBeInTheDocument();
    expect(within(summary).getByText("disabled")).toBeInTheDocument();
  });

  it("opens the case editor for ?case=<uuid> and clears the param on close", async () => {
    const user = userEvent.setup();
    const caseRecord: EvalCaseRecord = {
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
    renderDashboard({ agents: [agent()], recent_batches: [] }, { "GET /eval-cases/case-1": caseRecord });

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByDisplayValue("stripe-key-leak")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));
    // useQueryParam removes the key by rewriting the URL through router.replace.
    expect(replace).toHaveBeenCalled();
    expect(String(replace.mock.calls.at(0)?.[0])).not.toContain("case=case-1");
  });
});
