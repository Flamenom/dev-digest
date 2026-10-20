import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal } from "@devdigest/ui";
import type { Agent, EvalBatchRecord, EvalCompare, EvalPromoteResult } from "@devdigest/shared";
import evalMessages from "../../../../../messages/en/eval.json";
import { renderWithProviders, type Routes } from "@/test/render-with-providers";
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

const AGENT: Agent = {
  id: "a-1",
  name: "Security Reviewer",
  description: "",
  provider: "openai",
  model: "gpt-4.1",
  system_prompt: "You are a security reviewer.",
  output_schema: null,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
  enabled: true,
  version: 10,
  attached_doc_paths: [],
};

function promoted(overrides: Partial<EvalPromoteResult> = {}): EvalPromoteResult {
  return { agent: AGENT, promoted_from_version: 7, new_version: 10, changed: true, ...overrides };
}

interface ModalApi {
  compare?: EvalCompare;
  promote?: EvalPromoteResult;
  session?: "admin" | "member";
}

function compareRoutes({ compare = compareFixture(), promote = promoted() }: ModalApi): Routes {
  return {
    "GET /evals/compare": compare,
    "POST /agents/a-1/versions/7/promote": promote,
  };
}

function renderModal(api: ModalApi = {}, props: Partial<CompareModalProps> = {}) {
  const onClose = props.onClose ?? vi.fn();
  const result = renderWithProviders(
    <CompareModal
      baseBatchId="b-base"
      headBatchId="b-head"
      agentId="a-1"
      currentVersion={9}
      {...props}
      onClose={onClose}
    />,
    { session: api.session ?? "admin", routes: compareRoutes(api) },
  );
  return { ...result, onClose };
}

/** The promote button once the session resolved to Admin (live). */
async function findLivePromote() {
  const promote = await screen.findByRole("button", { name: "Promote v7" });
  await waitFor(() => expect(promote).not.toHaveAttribute("aria-disabled"));
  return promote;
}

/* ---------------------------------------------------------------- tests -- */

describe("CompareModal delta cards", () => {
  it("encodes every metric change with a glyph and unit text, not colour alone (AC-44)", async () => {
    renderModal();

    // Each card shows both endpoints and a signed, unit-bearing delta.
    expect(await screen.findByText("78% → 82%")).toBeInTheDocument();
    expect(screen.getByText("▲4pt")).toBeInTheDocument();
    expect(screen.getByText("90% → 86%")).toBeInTheDocument();
    expect(screen.getByText("▼4pt")).toBeInTheDocument();
    expect(screen.getByText("=0pt")).toBeInTheDocument();

    // Cost is money, so it carries a currency magnitude rather than points.
    expect(screen.getByText("$0.0121 → $0.0152")).toBeInTheDocument();
    expect(screen.getByText("▲$0.0031")).toBeInTheDocument();
  });

  it("renders an em dash for a null delta and drops the COST card when a side is null", async () => {
    renderModal({
      compare: compareFixture({
        base: batch({ recall: null, cost_usd: null }),
        head: batch({ batch_id: "b-head", agent_version: 9, recall: 0.82, cost_usd: 0.0152 }),
        deltas: { recall: null, precision: 0, citation_accuracy: 0, cost_usd: null },
      }),
    });

    expect(await screen.findByText("— → 82%")).toBeInTheDocument();
    // The recall delta itself is a bare em dash, never a vacuous "0pt".
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText(evalMessages.compare.delta.cost)).not.toBeInTheDocument();
  });
});

describe("CompareModal comparability", () => {
  it("warns above the delta cards and names the changed cases (AC-33)", async () => {
    renderModal({ compare: compareFixture({ comparable: false, changed_case_ids: ["case-a", "case-b"] }) });

    const strip = await screen.findByRole("alert");
    expect(strip).toHaveTextContent(evalMessages.compare.notComparable);
    expect(strip).toHaveTextContent("2 cases changed");
    expect(strip).toHaveTextContent("case-a");
    expect(strip).toHaveTextContent("case-b");

    // "above the deltas": the strip precedes the first metric card in the DOM.
    const recallCard = screen.getByText("Recall");
    expect(strip.compareDocumentPosition(recallCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no warning strip when the two batches ran the same case set", async () => {
    renderModal();
    expect(await screen.findByText("78% → 82%")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("CompareModal system prompt diff", () => {
  it("renders the diff as escaped plain text with leading +/− characters", async () => {
    renderModal();

    const block = await screen.findByRole("group", { name: evalMessages.compare.promptDiff });
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

  it("explains an unavailable diff instead of rendering a fake one", async () => {
    renderModal({ compare: compareFixture({ prompt_diff_available: false, prompt_diff: [] }) });

    expect(await screen.findByText(evalMessages.compare.promptDiffUnavailable)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: evalMessages.compare.promptDiff })).not.toBeInTheDocument();
  });
});

describe("CompareModal dialog behaviour (AC-45)", () => {
  it("traps focus and Escape closes only the compare modal, not the dialog under it", async () => {
    const user = userEvent.setup();
    const closeUnderlying = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(
      <>
        <Modal title="Underlying dialog" onClose={closeUnderlying} />
        <CompareModal baseBatchId="b-base" headBatchId="b-head" agentId="a-1" currentVersion={9} onClose={onClose} />
      </>,
      { routes: compareRoutes({}) },
    );

    const dialog = screen.getByRole("dialog", { name: evalMessages.compare.title });
    // Opening moves focus inside the topmost dialog.
    expect(dialog.contains(document.activeElement)).toBe(true);
    await screen.findByText("78% → 82%");

    // Tab from the last focusable wraps back inside — focus never reaches the
    // dialog underneath.
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>("button, a[href], input, textarea, select"),
    );
    const first = focusables.at(0);
    const last = focusables.at(-1);
    if (!first || !last) throw new Error("no focusables in the dialog");
    last.focus();
    await user.tab();
    expect(document.activeElement).toBe(first);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(closeUnderlying).not.toHaveBeenCalled();
  });
});

describe("CompareModal promote", () => {
  it("confirms the append-only version bump before promoting, then toasts it", async () => {
    const user = userEvent.setup();
    const { router } = renderModal();

    await user.click(await findLivePromote());
    // §9.2: the copy must say a NEW version is created, not that v9 is rolled back.
    expect(screen.getByText(/this creates v10 with v7's settings/)).toBeInTheDocument();
    expect(router.calls.some((c) => c.method === "POST")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Promote v7" }));
    expect(await screen.findByText("v7 promoted as v10.")).toBeInTheDocument();
    expect(router.calls.find((c) => c.method === "POST")?.path).toBe("/agents/a-1/versions/7/promote");
  });

  it("reports an unchanged configuration instead of claiming a new version", async () => {
    const user = userEvent.setup();
    renderModal({ promote: promoted({ new_version: 9, changed: false }) });

    await user.click(await findLivePromote());
    await user.click(screen.getByRole("button", { name: "Promote v7" }));

    expect(await screen.findByText("v7 is already the active configuration.")).toBeInTheDocument();
  });

  it("Member: Promote is aria-disabled with an 'Admins only' description and never confirms (AC-33)", async () => {
    const user = userEvent.setup();
    const { router, onClose } = renderModal({ session: "member" });
    const promote = await screen.findByRole("button", { name: "Promote v7", description: "Admins only" });
    expect(promote).toHaveAttribute("aria-disabled", "true");
    await user.click(promote);
    // Sync point: an action a Member CAN take after the gated click (Escape
    // dismisses the modal) — the click's effects are committed by then.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/this creates v10/)).not.toBeInTheDocument();
    expect(router.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("offers no promote action when the base batch has no recorded version", async () => {
    renderModal({ compare: compareFixture({ promote_target_version: null }) });

    expect(await screen.findByText("78% → 82%")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Promote/ })).not.toBeInTheDocument();
    // The modal still renders and is still dismissible.
    expect(screen.getByRole("dialog", { name: evalMessages.compare.title })).toBeInTheDocument();
  });
});
