/**
 * RunHistory — the badge must reflect the review OUTCOME, not the run lifecycle.
 * Regression guard for the "green ✓ done on a run that found 5 blockers" bug:
 * a settled run is colored/labelled by its denormalized blocker/finding counts,
 * and shows the review score ring.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { RunSummary } from "@devdigest/shared";
import type { RunSummaryWithActor } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/prReview.json";
import authMessages from "../../../../../../../../messages/en/auth.json";
import { RunHistory } from "./RunHistory";

afterEach(cleanup);

function run(o: Partial<RunSummaryWithActor>): RunSummaryWithActor {
  return {
    run_id: "run-1",
    agent_id: "a1",
    agent_name: "Security Reviewer",
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash",
    status: "done",
    error: null,
    duration_ms: 1000,
    tokens_in: 100,
    tokens_out: 50,
    cost_usd: null,
    findings_count: 0,
    grounding: "0/0 passed",
    ran_at: "2026-06-11T18:44:34.000Z",
    score: null,
    blockers: null,
    ...o,
  };
}

function renderRuns(runs: RunSummary[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ prReview: messages }}>
      <RunHistory runs={runs} onOpenTrace={() => {}} />
    </NextIntlClientProvider>,
  );
}

describe("RunHistory — outcome badge", () => {
  it("a done run WITH blockers reads 'rejected' (never green 'done') + shows the score ring", () => {
    renderRuns([run({ status: "done", findings_count: 5, blockers: 5, score: 0 })]);
    expect(screen.getByText("rejected")).toBeInTheDocument();
    expect(screen.queryByText("done")).not.toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument(); // CircularScore renders the number
    expect(screen.getByText(/5 blockers/)).toBeInTheDocument();
  });

  it("a clean done run reads 'approved'", () => {
    renderRuns([run({ status: "done", findings_count: 0, blockers: 0, score: 95 })]);
    expect(screen.getByText("approved")).toBeInTheDocument();
    expect(screen.getByText("95")).toBeInTheDocument();
  });

  it("a done run with non-blocking findings reads 'reviewed'", () => {
    renderRuns([run({ status: "done", findings_count: 3, blockers: 0, score: 72 })]);
    expect(screen.getByText("reviewed")).toBeInTheDocument();
    expect(screen.queryByText(/blockers/)).not.toBeInTheDocument();
  });

  it("a settled run shows tokens + cost next to the time", () => {
    renderRuns([
      run({ status: "done", tokens_in: 8000, tokens_out: 1119, cost_usd: 0.0013, findings_count: 3, blockers: 2, score: 61 }),
    ]);
    expect(screen.getByText(/9,119 tok/)).toBeInTheDocument();
    expect(screen.getByText("$0.0013")).toBeInTheDocument();
  });

  it("a failed run reads 'error'", () => {
    renderRuns([run({ status: "failed", error: "boom", score: null, blockers: null })]);
    expect(screen.getByText("error")).toBeInTheDocument();
  });

  it("a running run reads 'running'", () => {
    renderRuns([run({ status: "running", score: null, blockers: null })]);
    expect(screen.getByText("running")).toBeInTheDocument();
  });
});

describe("RunHistory — initiator label (AC-45, AC-48)", () => {
  it("shows 'Run by <name>', 'Run by Local user' for the seeded user and '—' when unknown", () => {
    const runs: RunSummaryWithActor[] = [
      run({ run_id: "a", ran_at: "2026-06-11T18:44:34.000Z", started_by: { user_id: "uA", name: "Alice" } }),
      run({ run_id: "b", ran_at: "2026-06-11T17:44:34.000Z", started_by: { user_id: "sys", name: "System", is_system: true } }),
      run({ run_id: "c", ran_at: "2026-06-11T16:44:34.000Z", started_by: null }),
      run({ run_id: "d", ran_at: "2026-06-11T15:44:34.000Z" }), // older server: no key → no label
    ];
    render(
      <NextIntlClientProvider locale="en" messages={{ prReview: messages, auth: authMessages }}>
        <RunHistory runs={runs} onOpenTrace={() => {}} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText("Run by Alice")).toBeInTheDocument();
    expect(screen.getByText("Run by Local user")).toBeInTheDocument();
    // "—" also appears as a placeholder elsewhere in a row; the actor label keeps
    // its full text in `title`, which identifies it.
    expect(screen.getAllByTitle("—")).toHaveLength(1);
  });
});
