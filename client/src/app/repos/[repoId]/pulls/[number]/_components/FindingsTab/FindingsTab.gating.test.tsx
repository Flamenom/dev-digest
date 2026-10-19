/**
 * PR page gating (AC-30 UI half, AC-33 PR rows): a Member sees Cancel only on
 * runs they started and never sees Delete run / Delete review; an Admin (and
 * local mode, where the seeded user is Admin) keeps every control. UX only —
 * the server enforces the same rules.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider, type UseMutationResult } from "@tanstack/react-query";
import type {
  CurrentSession,
  ReviewRecordWithActor,
  Role,
  RunSummaryWithActor,
} from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/prReview.json";
import authMessages from "../../../../../../../../messages/en/auth.json";

// Live progress streams over EventSource (jsdom has none) — not under test here.
vi.mock("../RunStatus", () => ({ RunStatus: () => null }));

import { FindingsTab } from "./FindingsTab";

afterEach(cleanup);

const ME = "uA";

function session(role: Role): CurrentSession {
  return {
    mode: "google",
    user: { id: ME, email: "a@onlytraf.com", name: "Alice", avatar_url: null, role },
    workspace: { id: "w1", name: "Team" },
  };
}

function run(o: Partial<RunSummaryWithActor>): RunSummaryWithActor {
  return {
    run_id: "run-1",
    agent_id: "a1",
    agent_name: "Security Reviewer",
    provider: "openrouter",
    model: "m",
    status: "done",
    error: null,
    duration_ms: 1000,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: null,
    findings_count: 0,
    grounding: "0/0 passed",
    ran_at: "2026-06-11T18:44:34.000Z",
    score: 90,
    blockers: 0,
    ...o,
  };
}

const PR_RUNS: RunSummaryWithActor[] = [
  run({ run_id: "mine", status: "running", ran_at: "2026-06-11T18:00:00.000Z", started_by: { user_id: ME, name: "Alice" } }),
  run({ run_id: "theirs", status: "running", ran_at: "2026-06-11T17:00:00.000Z", started_by: { user_id: "uB", name: "Bob" } }),
  run({ run_id: "settled", status: "done", ran_at: "2026-06-11T16:00:00.000Z", started_by: { user_id: "uB", name: "Bob" } }),
];

const REVIEW: ReviewRecordWithActor = {
  id: "rev-1",
  pr_id: "pr-1",
  agent_id: "a1",
  agent_name: "Security Reviewer",
  run_id: "settled",
  kind: "review",
  verdict: "approve",
  summary: "Looks fine",
  score: 90,
  model: "m",
  provider: "openrouter",
  tokens_in: 0,
  tokens_out: 0,
  cost_usd: null,
  created_at: "2026-06-11T16:00:00.000Z",
  started_by: { user_id: "uB", name: "Bob" },
  findings: [],
} as unknown as ReviewRecordWithActor;

function renderTab(role: Role) {
  const qc = new QueryClient();
  qc.setQueryData(["session"], session(role));
  const mutate = vi.fn();
  const cancelMutation = { mutate, isPending: false } as unknown as UseMutationResult<
    unknown,
    unknown,
    string,
    unknown
  >;
  const onDelete = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={{ prReview: messages, auth: authMessages }}>
      <QueryClientProvider client={qc}>
        <FindingsTab
          prId="pr-1"
          liveRunIds={["mine", "theirs"]}
          reviewRunning
          lethalTrifecta={[]}
          runs={[REVIEW]}
          prRuns={PR_RUNS}
          prCommits={[]}
          cancelMutation={cancelMutation}
          repo={null}
          readOnly={false}
          onOpenTrace={() => {}}
          onDelete={onDelete}
          onRunDone={() => {}}
        />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { mutate, onDelete };
}

describe("FindingsTab — run gating", () => {
  it("Member: cancels only their own run (row + live Cancel), no Delete run / Delete review, sees initiators", () => {
    const { mutate } = renderTab("member");

    // Exactly one per-row Cancel — on the run the Member started.
    const cancels = screen.getAllByRole("button", { name: "Cancel run" });
    expect(cancels).toHaveLength(1);
    fireEvent.click(cancels[0]!);
    expect(mutate).toHaveBeenLastCalledWith("mine");

    // The live "Cancel" cancels only the Member's own live run.
    mutate.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith("mine");

    expect(screen.queryByRole("button", { name: "Delete run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete this review run" })).not.toBeInTheDocument();

    expect(screen.getByText("Run by Alice")).toBeInTheDocument();
    // Bob started the running row, the settled row and the review accordion.
    expect(screen.getAllByText("Run by Bob")).toHaveLength(3);
  });

  it("Admin: cancels any run and keeps Delete run / Delete review", () => {
    const { mutate, onDelete } = renderTab("admin");

    expect(screen.getAllByRole("button", { name: "Cancel run" })).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mutate).toHaveBeenCalledWith("mine");
    expect(mutate).toHaveBeenCalledWith("theirs");

    const settledRow = screen.getByRole("button", { name: "Delete run" });
    fireEvent.click(settledRow);
    expect(onDelete).toHaveBeenCalledWith("settled");
    expect(screen.getByRole("button", { name: "Delete this review run" })).toBeInTheDocument();
  });
});
