/**
 * PR page gating (AC-30 UI half, AC-33 PR rows): a Member sees Cancel only on
 * runs they started and never sees Delete run / Delete review; an Admin (and
 * local mode, where the seeded user is Admin) keeps every control. UX only —
 * the server enforces the same rules.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReviewRecordWithActor, Role, RunSummaryWithActor } from "@devdigest/shared";
import { useCancelRun } from "@/lib/hooks/reviews";
import { renderWithProviders, sessionFor } from "@/test/render-with-providers";
import { FindingsTab } from "./FindingsTab";

const ME = "uA";

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

/** The PR page passes its real cancel mutation down; so does this harness. */
function FindingsTabWithCancel({ onDelete }: { onDelete: (runId: string) => void }) {
  const cancel = useCancelRun();
  return (
    <FindingsTab
      prId="pr-1"
      liveRunIds={["mine", "theirs"]}
      reviewRunning
      lethalTrifecta={[]}
      runs={[REVIEW]}
      prRuns={PR_RUNS}
      prCommits={[]}
      cancelMutation={cancel}
      repo={null}
      readOnly={false}
      onOpenTrace={() => {}}
      onDelete={onDelete}
      onRunDone={() => {}}
    />
  );
}

function renderTab(role: Role) {
  const onDelete = vi.fn();
  const { router } = renderWithProviders(<FindingsTabWithCancel onDelete={onDelete} />, {
    session: sessionFor(role, { userId: ME, name: "Alice" }),
    routes: { "POST /runs/:id/cancel": { ok: true } },
  });
  const cancelled = () =>
    router.calls.filter((c) => c.method === "POST").map((c) => c.path.split("/").at(2));
  return { onDelete, cancelled };
}

describe("FindingsTab — run gating", () => {
  it("Member: cancels only their own run (row + live Cancel), no Delete run / Delete review, sees initiators", async () => {
    const { cancelled } = renderTab("member");

    // Exactly one per-row Cancel — on the run the Member started (once the session resolved).
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Cancel run" })).toHaveLength(1));
    const [ownCancel] = screen.getAllByRole("button", { name: "Cancel run" });
    if (!ownCancel) throw new Error("no Cancel run button");
    fireEvent.click(ownCancel);
    await waitFor(() => expect(cancelled()).toEqual(["mine"]));

    // The live "Cancel" cancels only the Member's own live run.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelled()).toEqual(["mine", "mine"]));

    expect(screen.queryByRole("button", { name: "Delete run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete this review run" })).not.toBeInTheDocument();

    expect(screen.getByText("Run by Alice")).toBeInTheDocument();
    // Bob started the running row, the settled row and the review accordion.
    expect(screen.getAllByText("Run by Bob")).toHaveLength(3);
  });

  it("Admin: cancels any run and keeps Delete run / Delete review", async () => {
    const { onDelete, cancelled } = renderTab("admin");

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Cancel run" })).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelled().sort()).toEqual(["mine", "theirs"]));

    fireEvent.click(screen.getByRole("button", { name: "Delete run" }));
    expect(onDelete).toHaveBeenCalledWith("settled");
    expect(screen.getByRole("button", { name: "Delete this review run" })).toBeInTheDocument();
  });
});
