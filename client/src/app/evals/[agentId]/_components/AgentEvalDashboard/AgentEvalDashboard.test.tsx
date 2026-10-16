import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type {
  EvalAgentDashboard as EvalAgentDashboardPayload,
  EvalAlertDetail,
  EvalBatchRecord,
  EvalTrendPoint,
} from "@devdigest/shared";
import evalMessages from "../../../../../../messages/en/eval.json";

/* The client test harness has no MSW and no QueryClientProvider: the data hooks
   are module-mocked and driven from this mutable state object. Every reference
   to `state` lives inside a returned hook body, which only runs at render time,
   so the factory never touches it before it is initialised. */
const state: {
  dashboard: {
    data: EvalAgentDashboardPayload | undefined;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => void;
  };
} = {
  dashboard: {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  },
};

const startBatchMutate = vi.fn();

vi.mock("@/lib/hooks/eval", () => ({
  EVAL_WINDOW_DAYS_DEFAULT: 30,
  useAgentEvalDashboard: () => state.dashboard,
  useEvalDashboard: () => ({ data: undefined }),
  useEvalBatch: () => ({ data: undefined }),
  useStartEvalBatch: () => ({ mutate: startBatchMutate, isPending: false }),
  // Imported (not called) by CompareModal, which this screen renders lazily.
  useEvalCompare: () => ({ data: undefined, isLoading: false, isError: false, error: null }),
  usePromoteAgentVersion: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

/* `?days=` is real URL state: `useQueryParam` reads `useSearchParams()` and
   writes through `router.replace`, so the mock exposes both. */
let searchParams = new URLSearchParams();
const routerReplace = vi.fn();
const routerPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace, push: routerPush }),
  useSearchParams: () => searchParams,
  useParams: () => ({ agentId: "a-1" }),
}));

import { AgentEvalDashboard } from "./AgentEvalDashboard";

/* ------------------------------------------------------------- fixtures -- */

function batch(overrides: Partial<EvalBatchRecord> = {}): EvalBatchRecord {
  return {
    batch_id: "b-1",
    agent_id: "a-1",
    agent_name: "Security Reviewer",
    agent_version: 7,
    ran_at: "2026-09-01T10:00:00.000Z",
    status: "complete",
    recall: 0.82,
    precision: 0.86,
    citation_accuracy: 0.95,
    cases_total: 10,
    cases_passed: 8,
    cases_failed: 2,
    cases_errored: 0,
    must_find_total: 8,
    must_find_matched: 6,
    must_not_flag_total: 2,
    noise_findings: 1,
    findings_total: 10,
    grounding_kept: 19,
    grounding_total: 20,
    duration_ms: 42_000,
    cost_usd: 0.0121,
    ...overrides,
  };
}

function trendPoint(overrides: Partial<EvalTrendPoint> = {}): EvalTrendPoint {
  return {
    ran_at: "2026-09-01T10:00:00.000Z",
    recall: 0.82,
    precision: 0.86,
    citation_accuracy: 0.95,
    pass_rate: 0.8,
    cost_usd: 0.0121,
    ...overrides,
  };
}

function payload(overrides: Partial<EvalAgentDashboardPayload> = {}): EvalAgentDashboardPayload {
  return {
    agent: {
      id: "a-1",
      name: "Security Reviewer",
      model: "anthropic/claude-sonnet-4",
      version: 9,
      provider: "openrouter",
    },
    window_days: 30,
    dashboard: {
      owner_kind: "agent",
      owner_id: "a-1",
      cases_total: 10,
      current: {
        recall: 0.82,
        precision: 0.86,
        citation_accuracy: 0.95,
        traces_passed: 8,
        traces_total: 10,
        cost_usd: 0.0121,
      },
      delta: { recall: 0.04, precision: -0.02, citation_accuracy: 0.02 },
      trend: [trendPoint()],
      recent_runs: [],
      alert: null,
    },
    batches: [batch()],
    alert: null,
    ...overrides,
  };
}

const ALERT: EvalAlertDetail = {
  tone: "warn",
  primary: { metric: "precision", direction: "down", delta_pts: -2 },
  others: [
    { metric: "recall", direction: "up", delta_pts: 3 },
    { metric: "citation_accuracy", direction: "up", delta_pts: 2 },
  ],
  new_false_positive: true,
  head_version: 7,
};

function renderScreen() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ eval: evalMessages }}>
      <AgentEvalDashboard agentId="a-1" />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  searchParams = new URLSearchParams();
  state.dashboard = {
    data: payload(),
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
});

afterEach(cleanup);

/* ---------------------------------------------------------------- tests -- */

describe("AgentEvalDashboard", () => {
  it("shows the window empty state and no cards when the range holds no batches (AC-23)", () => {
    state.dashboard.data = payload({
      batches: [],
      dashboard: { ...payload().dashboard, trend: [] },
    });
    const { rerender } = renderScreen();

    // Default window is 30 days, so the empty state names the window.
    expect(screen.getByText("No eval runs in the last 30 days.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Metric trend" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Recent runs" })).not.toBeInTheDocument();

    // "All time" has no day count, so it falls back to the generic message.
    searchParams = new URLSearchParams("days=all");
    rerender(
      <NextIntlClientProvider locale="en" messages={{ eval: evalMessages }}>
        <AgentEvalDashboard agentId="a-1" />
      </NextIntlClientProvider>,
    );
    expect(
      screen.getByText("No runs yet. Create an eval case and run it."),
    ).toBeInTheDocument();
  });

  it("composes the alert banner through next-intl and renders none when nothing moved (AC-26, AC-44)", () => {
    state.dashboard.data = payload({ alert: ALERT });
    const { rerender } = renderScreen();

    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("Precision dipped 2 pts on v7");
    expect(banner).toHaveTextContent("a new false positive slipped in.");
    // `{metrics}` carries the glyph + points text; the message is only a frame.
    expect(banner).toHaveTextContent("Recall ▲3pt, Citation ▲2pt are both up.");

    // No significant metric → the server sends `alert: null` → no banner.
    state.dashboard.data = payload({ alert: null });
    rerender(
      <NextIntlClientProvider locale="en" messages={{ eval: evalMessages }}>
        <AgentEvalDashboard agentId="a-1" />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("draws a visible marker for a one-point trend and an empty state for a zero-point one (AC-28)", () => {
    const { rerender } = renderScreen();

    const oneTrend = screen.getByRole("region", { name: "Metric trend" });
    expect(within(oneTrend).getByText("Recall 82%")).toBeInTheDocument();
    expect(within(oneTrend).getByText("Precision 86%")).toBeInTheDocument();
    expect(within(oneTrend).getByText("Citation 95%")).toBeInTheDocument();

    state.dashboard.data = payload({
      dashboard: { ...payload().dashboard, trend: [] },
    });
    rerender(
      <NextIntlClientProvider locale="en" messages={{ eval: evalMessages }}>
        <AgentEvalDashboard agentId="a-1" />
      </NextIntlClientProvider>,
    );
    const zeroTrend = screen.getByRole("region", { name: "Metric trend" });
    expect(
      within(zeroTrend).getByText("No runs yet. Create an eval case and run it."),
    ).toBeInTheDocument();
    expect(within(zeroTrend).queryByText("Recall 82%")).not.toBeInTheDocument();
  });

  it("caps the compare selection at two, dropping the oldest tick", () => {
    state.dashboard.data = payload({
      batches: [
        batch({ batch_id: "b-3", ran_at: "2026-09-03T10:00:00.000Z" }),
        batch({ batch_id: "b-2", ran_at: "2026-09-02T10:00:00.000Z" }),
        batch({ batch_id: "b-1", ran_at: "2026-09-01T10:00:00.000Z" }),
      ],
    });
    renderScreen();

    const compare = screen.getByRole("button", { name: "Compare eval batches" });
    expect(compare).toBeDisabled();

    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);

    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    expect(screen.getByRole("button", { name: "Compare eval batches" })).toBeEnabled();

    // Ticking a third drops the FIRST tick rather than dead-ending the control.
    fireEvent.click(screen.getAllByRole("checkbox")[2]!);
    const after = screen.getAllByRole("checkbox");
    expect(after[0]!).toHaveAttribute("aria-checked", "false");
    expect(after[1]!).toHaveAttribute("aria-checked", "true");
    expect(after[2]!).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Compare eval batches" })).toBeEnabled();
  });

  it("reports live batch progress in the Run eval label and in the table row (AC-22)", () => {
    state.dashboard.data = payload({
      batches: [
        batch({
          batch_id: "b-live",
          ran_at: "2026-09-04T10:00:00.000Z",
          status: "running",
          cases_total: 20,
          cases_passed: 5,
          cases_failed: 1,
          cases_errored: 1,
          recall: null,
          precision: null,
          citation_accuracy: null,
          cost_usd: null,
        }),
        batch(),
      ],
    });
    renderScreen();

    const runButton = screen.getByRole("button", { name: "Running… 7/20" });
    expect(runButton).toBeDisabled();

    // The row shows progress instead of numbers, and offers no compare tick.
    const table = screen.getByRole("region", { name: "Recent runs" });
    expect(within(table).getByText("Running… 7/20")).toBeInTheDocument();
    expect(within(table).getAllByRole("checkbox")).toHaveLength(1);
  });

  it("mirrors the date-range control into the URL", () => {
    renderScreen();

    fireEvent.click(screen.getByRole("button", { name: "7 days" }));

    expect(routerReplace).toHaveBeenCalledWith(
      expect.stringContaining("days=7"),
      expect.objectContaining({ scroll: false }),
    );
  });
});
