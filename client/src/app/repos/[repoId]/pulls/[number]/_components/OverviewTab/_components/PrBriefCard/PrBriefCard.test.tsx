import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from "vitest";
// NOTE: @testing-library/user-event is not a client devDependency; the whole
// suite interacts via fireEvent (see IntentCard/SkillsTab tests) — we follow
// that pattern rather than adding a package from a test file.
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PrBriefDetail } from "@devdigest/shared";
import { riskLevelFromScore } from "@devdigest/shared";
import briefMessages from "../../../../../../../../../../messages/en/brief.json";
import prReviewMessages from "../../../../../../../../../../messages/en/prReview.json";
import { RISK_LEVEL_COLOR } from "./constants";

// The card talks to the API through lib/api only (regenerate + the reviews
// query behind the findings panel) — mock it wholesale so the real TanStack
// Query hooks run against fake fetches.
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

import { api } from "@/lib/api";
import { PrBriefCard } from "./PrBriefCard";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  // No reviews needed for the header numbers — they come from the payload.
  (api.get as Mock).mockResolvedValue([]);
});

const BRIEF: PrBriefDetail = {
  pr_id: "pr-1",
  what: "Adds per-IP rate limiting middleware to every public API endpoint.",
  why: "Unauthenticated clients were able to exhaust the payments API.",
  risks: [],
  review_focus: [],
  score: 61,
  risk_level: "medium",
  status: "request_changes",
  findings_count: 6,
  blockers: 2,
  cost_usd: 0.014,
  tokens_in: 8231,
  tokens_out: 1340,
  missing_inputs: [],
  model: "google/gemini-2.5-flash-lite",
  head_sha: "sha-1",
  generated_at: "2026-08-27T00:00:00.000Z",
  stale: false,
  stale_reason: null,
  generation: { state: "ok", reason: null },
};

function renderCard(overrides: Partial<PrBriefDetail> = {}, props: { onRunReview?: () => void } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider
        locale="en"
        messages={{ brief: briefMessages, prReview: prReviewMessages }}
      >
        <PrBriefCard prId="pr-1" brief={{ ...BRIEF, ...overrides }} {...props} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return result;
}

/** The gauge's own band colour — the second <circle> carries the arc stroke. */
function gaugeStroke(container: HTMLElement): string | null {
  const circles = container.querySelectorAll("circle");
  return circles[circles.length - 1]?.getAttribute("stroke") ?? null;
}

describe("PrBriefCard", () => {
  it("reviewed PR: verdict, gauge + risk band, findings badge, cost, tokens and prose", () => {
    renderCard();

    // Deterministic header (AC-15, AC-16, AC-17, AC-19, AC-40, AC-42).
    expect(screen.getByText("Request changes")).toBeInTheDocument();
    expect(screen.getByText("61")).toBeInTheDocument();
    expect(screen.getByText("PR SCORE")).toBeInTheDocument();
    expect(screen.getByText("Medium risk")).toBeInTheDocument();
    expect(screen.getByText("6 findings · 2 blockers")).toBeInTheDocument();
    expect(screen.getByText("$0.014")).toBeInTheDocument();
    expect(screen.getByText("8.2K → 1.3K tokens")).toBeInTheDocument();

    // The findings badge is a real focusable trigger for the panel (AC-20).
    expect(
      screen.getByRole("button", { name: "6 findings · 2 blockers" }),
    ).toBeInTheDocument();

    // Model prose, rendered as text (AC-40, NFR-6).
    expect(
      screen.getByText("Adds per-IP rate limiting middleware to every public API endpoint."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Unauthenticated clients were able to exhaust the payments API."),
    ).toBeInTheDocument();
  });

  it("unreviewed PR: not-reviewed state + review CTA, no gauge and no risk label, prose still renders", () => {
    const onRunReview = vi.fn();
    renderCard(
      {
        status: "not_reviewed",
        score: null,
        risk_level: null,
        findings_count: 0,
        blockers: 0,
        cost_usd: null,
        tokens_in: null,
        tokens_out: null,
        missing_inputs: [{ input: "reviews", reason: "No review has run for this PR yet." }],
      },
      { onRunReview },
    );

    expect(screen.getByText("Not reviewed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Run a review/ }));
    expect(onRunReview).toHaveBeenCalledTimes(1);

    // AC-18a — both derive from the score, so both are omitted entirely.
    expect(screen.queryByText("PR SCORE")).not.toBeInTheDocument();
    expect(screen.queryByText(/risk$/i)).not.toBeInTheDocument();

    // AC-19 — no recorded cost renders an em dash, never "$0.00".
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();

    // The brief itself still rendered (AC-18a) and names its missing input (AC-34).
    expect(
      screen.getByText("Adds per-IP rate limiting middleware to every public API endpoint."),
    ).toBeInTheDocument();
    expect(screen.getByText("Missing inputs")).toBeInTheDocument();
    expect(screen.getByText(/No review has run for this PR yet\./)).toBeInTheDocument();
  });

  it("failed generation: the full deterministic header still renders, with an error note instead of prose", () => {
    renderCard({
      what: null,
      why: null,
      generation: { state: "failed", reason: "The model provider returned 503." },
    });

    // NFR-7 / AC-36 — the header is computed from review data, so it survives.
    expect(screen.getByText("Request changes")).toBeInTheDocument();
    expect(screen.getByText("61")).toBeInTheDocument();
    expect(screen.getByText("Medium risk")).toBeInTheDocument();
    expect(screen.getByText("6 findings · 2 blockers")).toBeInTheDocument();
    expect(screen.getByText("$0.014")).toBeInTheDocument();

    expect(screen.getByText("Brief generation failed.")).toBeInTheDocument();
    expect(screen.getByText("The model provider returned 503.")).toBeInTheDocument();
    expect(
      screen.queryByText("Adds per-IP rate limiting middleware to every public API endpoint."),
    ).not.toBeInTheDocument();
  });

  it("reload: fires one regeneration, shows a busy control, keeps the old prose, and rejects a second click", async () => {
    // Never resolves → the mutation stays pending for the whole assertion block.
    (api.post as Mock).mockReturnValue(new Promise(() => {}));
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate brief" }));

    // Busy immediately (NFR-2: within 100 ms), and the control is disabled.
    const busy = await screen.findByRole("button", { name: "Regenerating…" });
    expect(busy).toBeDisabled();
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/pulls/pr-1/brief"));

    // AC-7 — the card never blanks out while regenerating.
    expect(
      screen.getByText("Adds per-IP rate limiting middleware to every public API endpoint."),
    ).toBeInTheDocument();

    fireEvent.click(busy);
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("stale payload: badge + reason render and nothing is regenerated automatically", async () => {
    renderCard({
      stale: true,
      stale_reason: "A new review run completed after this brief was generated.",
    });

    expect(screen.getByText("Stale")).toBeInTheDocument();
    expect(
      screen.getByText("A new review run completed after this brief was generated."),
    ).toBeInTheDocument();
    // AC-5 / N5 — staleness is data, never an automatic (billable) regeneration.
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(api.post).not.toHaveBeenCalled();
  });

  it("stale payload without a server reason falls back to the generic explanation", () => {
    renderCard({ stale: true, stale_reason: null });
    expect(
      screen.getByText(
        "Inputs changed since this brief was generated. Regenerate to refresh it.",
      ),
    ).toBeInTheDocument();
  });

  it.each([
    [75, "low", "Low risk"],
    [74, "medium", "Medium risk"],
    [50, "medium", "Medium risk"],
    [49, "high", "High risk"],
  ])(
    "score %i: the risk label matches the gauge's own band colour",
    (score, level, label) => {
      // The bands are NOT re-derived in the card — this asserts the payload's
      // `risk_level` and the gauge colour can never disagree (AC-16a, AC-40).
      expect(riskLevelFromScore(score)).toBe(level);
      const { container } = renderCard({ score, risk_level: riskLevelFromScore(score) });

      expect(screen.getByText(label)).toBeInTheDocument();
      expect(gaugeStroke(container)).toBe(
        RISK_LEVEL_COLOR[level as keyof typeof RISK_LEVEL_COLOR],
      );
    },
  );
});
