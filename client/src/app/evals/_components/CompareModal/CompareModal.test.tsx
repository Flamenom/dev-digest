import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { Modal } from "@devdigest/ui";
import type { EvalBatchRecord, EvalCompare, EvalPromoteResult } from "@devdigest/shared";
import evalMessages from "../../../../../messages/en/eval.json";

/* The client test harness has no MSW and no QueryClientProvider: the hooks are
   module-mocked and driven from this mutable state object. Every reference to
   `state` lives inside the returned hook bodies, which only run at render time,
   so the factory never touches it before it is initialised. */
const state: {
  compare: { data: EvalCompare | undefined; isLoading: boolean; isError: boolean; error: unknown };
  promoteResult: EvalPromoteResult;
  promotePending: boolean;
} = {
  compare: { data: undefined, isLoading: false, isError: false, error: null },
  promoteResult: {} as EvalPromoteResult,
  promotePending: false,
};

const promoteMutate = vi.fn(
  (
    _vars: { agentId: string; version: number },
    opts?: { onSuccess?: (r: EvalPromoteResult) => void },
  ) => opts?.onSuccess?.(state.promoteResult),
);

vi.mock("@/lib/hooks/eval", () => ({
  useEvalCompare: () => state.compare,
  usePromoteAgentVersion: () => ({ mutate: promoteMutate, isPending: state.promotePending }),
}));

const toastSuccess = vi.fn();
vi.mock("@/lib/toast", () => ({
  useToast: () => ({ success: toastSuccess, error: vi.fn(), info: vi.fn() }),
}));

import { CompareModal, type CompareModalProps } from "./CompareModal";

/* ------------------------------------------------------------- fixtures -- */

function batch(overrides: Partial<EvalBatchRecord> = {}): EvalBatchRecord {
  return {
    batch_id: "b-base",
    agent_id: "a-1",
    agent_name: "Security Reviewer",
    agent_version: 7,
    ran_at: "2026-09-01T10:00:00.000Z",
    status: "complete",
    recall: 0.78,
    precision: 0.9,
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

function compareFixture(overrides: Partial<EvalCompare> = {}): EvalCompare {
  return {
    base: batch(),
    head: batch({
      batch_id: "b-head",
      agent_version: 9,
      ran_at: "2026-09-02T10:00:00.000Z",
      recall: 0.82,
      precision: 0.86,
      cost_usd: 0.0152,
    }),
    // recall up 4pt, precision down 4pt, citation flat, cost up $0.0031.
    deltas: { recall: 0.04, precision: -0.04, citation_accuracy: 0, cost_usd: 0.0031 },
    comparable: true,
    changed_case_ids: [],
    prompt_diff: [
      { kind: "context", text: "You are a security reviewer." },
      { kind: "removed", text: "Flag every nit." },
      // Author-controlled prompt text: must reach the DOM escaped (§16).
      { kind: "added", text: "<script>alert('xss')</script>" },
    ],
    prompt_diff_available: true,
    promote_target_version: 7,
    ...overrides,
  };
}

function renderModal(props: Partial<CompareModalProps> = {}) {
  const onClose = props.onClose ?? vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={{ eval: evalMessages }}>
      <CompareModal
        baseBatchId="b-base"
        headBatchId="b-head"
        agentId="a-1"
        currentVersion={9}
        {...props}
        onClose={onClose}
      />
    </NextIntlClientProvider>,
  );
  return onClose;
}

beforeEach(() => {
  state.compare = { data: compareFixture(), isLoading: false, isError: false, error: null };
  state.promoteResult = {
    agent: {} as EvalPromoteResult["agent"],
    promoted_from_version: 7,
    new_version: 10,
    changed: true,
  };
  state.promotePending = false;
});

afterEach(() => {
  cleanup();
  promoteMutate.mockClear();
  toastSuccess.mockClear();
});

/* ---------------------------------------------------------------- tests -- */

describe("CompareModal delta cards", () => {
  it("encodes every metric change with a glyph and unit text, not colour alone (AC-44)", () => {
    renderModal();

    // Each card shows both endpoints and a signed, unit-bearing delta.
    expect(screen.getByText("78% → 82%")).toBeInTheDocument();
    expect(screen.getByText("▲4pt")).toBeInTheDocument();
    expect(screen.getByText("90% → 86%")).toBeInTheDocument();
    expect(screen.getByText("▼4pt")).toBeInTheDocument();
    expect(screen.getByText("=0pt")).toBeInTheDocument();

    // Cost is money, so it carries a currency magnitude rather than points.
    expect(screen.getByText("$0.0121 → $0.0152")).toBeInTheDocument();
    expect(screen.getByText("▲$0.0031")).toBeInTheDocument();
  });

  it("renders an em dash for a null delta and drops the COST card when a side is null", () => {
    state.compare.data = compareFixture({
      base: batch({ recall: null, cost_usd: null }),
      head: batch({ batch_id: "b-head", agent_version: 9, recall: 0.82, cost_usd: 0.0152 }),
      deltas: { recall: null, precision: 0, citation_accuracy: 0, cost_usd: null },
    });
    renderModal();

    expect(screen.getByText("— → 82%")).toBeInTheDocument();
    // The recall delta itself is a bare em dash, never a vacuous "0pt".
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText(evalMessages.compare.delta.cost)).not.toBeInTheDocument();
  });
});

describe("CompareModal comparability", () => {
  it("warns above the delta cards and names the changed cases (AC-33)", () => {
    state.compare.data = compareFixture({
      comparable: false,
      changed_case_ids: ["case-a", "case-b"],
    });
    renderModal();

    const strip = screen.getByRole("alert");
    expect(strip).toHaveTextContent(evalMessages.compare.notComparable);
    expect(strip).toHaveTextContent("2 cases changed");
    expect(strip).toHaveTextContent("case-a");
    expect(strip).toHaveTextContent("case-b");

    // "above the deltas": the strip precedes the first metric card in the DOM.
    const recallCard = screen.getByText("Recall");
    expect(strip.compareDocumentPosition(recallCard) & Node.DOCUMENT_POSITION_FOLLOWING).
      toBeTruthy();
  });

  it("shows no warning strip when the two batches ran the same case set", () => {
    renderModal();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("CompareModal system prompt diff", () => {
  it("renders the diff as escaped plain text with leading +/− characters", () => {
    renderModal();

    const block = screen.getByRole("group", { name: evalMessages.compare.promptDiff });
    expect(block.textContent).toContain("−Flag every nit.");
    expect(block.textContent).toContain("+<script>alert('xss')</script>");
    expect(block.textContent).toContain(" You are a security reviewer.");

    // The prompt is author-controlled text (§16): it must never become markup.
    expect(block.querySelector("script")).toBeNull();
    expect(block.innerHTML).toContain("&lt;script&gt;");

    // The legend names both sides in text as well as colour.
    expect(screen.getByText(evalMessages.compare.legendOld)).toBeInTheDocument();
    expect(screen.getByText(evalMessages.compare.legendNew)).toBeInTheDocument();
  });

  it("explains an unavailable diff instead of rendering a fake one", () => {
    state.compare.data = compareFixture({ prompt_diff_available: false, prompt_diff: [] });
    renderModal();

    expect(screen.getByText(evalMessages.compare.promptDiffUnavailable)).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: evalMessages.compare.promptDiff }),
    ).not.toBeInTheDocument();
  });
});

describe("CompareModal dialog behaviour (AC-45)", () => {
  it("traps focus and Escape closes only the compare modal, not the dialog under it", () => {
    const closeUnderlying = vi.fn();
    const onClose = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={{ eval: evalMessages }}>
        <Modal title="Underlying dialog" onClose={closeUnderlying} />
        <CompareModal
          baseBatchId="b-base"
          headBatchId="b-head"
          agentId="a-1"
          currentVersion={9}
          onClose={onClose}
        />
      </NextIntlClientProvider>,
    );

    const dialog = screen.getByRole("dialog", { name: evalMessages.compare.title });
    // Opening moves focus inside the topmost dialog.
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Tab from the last focusable wraps back inside — focus never reaches the
    // dialog underneath.
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>("button, a[href], input, textarea, select"),
    );
    focusables[focusables.length - 1]!.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(focusables[0]);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(closeUnderlying).not.toHaveBeenCalled();
  });
});

describe("CompareModal promote", () => {
  it("confirms the append-only version bump before promoting, then toasts it", () => {
    renderModal();

    fireEvent.click(screen.getByRole("button", { name: "Promote v7" }));
    // §9.2: the copy must say a NEW version is created, not that v9 is rolled back.
    expect(screen.getByText(/this creates v10 with v7's settings/)).toBeInTheDocument();
    expect(promoteMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Promote v7" }));
    expect(promoteMutate).toHaveBeenCalledTimes(1);
    expect(promoteMutate.mock.calls[0]![0]).toEqual({ agentId: "a-1", version: 7 });
    expect(toastSuccess).toHaveBeenCalledWith("v7 promoted as v10.");
  });

  it("reports an unchanged configuration instead of claiming a new version", () => {
    state.promoteResult = {
      agent: {} as EvalPromoteResult["agent"],
      promoted_from_version: 7,
      new_version: 9,
      changed: false,
    };
    renderModal();

    fireEvent.click(screen.getByRole("button", { name: "Promote v7" }));
    fireEvent.click(screen.getByRole("button", { name: "Promote v7" }));

    expect(toastSuccess).toHaveBeenCalledWith("v7 is already the active configuration.");
  });

  it("offers no promote action when the base batch has no recorded version", () => {
    state.compare.data = compareFixture({ promote_target_version: null });
    renderModal();

    expect(screen.queryByRole("button", { name: /Promote/ })).not.toBeInTheDocument();
    // The modal still renders and is still dismissible.
    expect(screen.getByRole("dialog", { name: evalMessages.compare.title })).toBeInTheDocument();
  });
});
