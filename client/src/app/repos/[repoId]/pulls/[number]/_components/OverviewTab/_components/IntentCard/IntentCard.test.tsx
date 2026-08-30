import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from "vitest";
// NOTE: @testing-library/user-event is not a client devDependency; the whole
// suite interacts via fireEvent (see SkillsTab/ConventionsView tests) — we
// follow that pattern rather than adding a package from a test file.
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BriefRisk, IntentDetail } from "@devdigest/shared";
import messages from "../../../../../../../../../../messages/en/brief.json";

// IntentCard talks to the API through lib/api only (via the intent hooks) —
// mock it wholesale so the real TanStack Query hooks run against fake fetches.
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

import { api } from "@/lib/api";
import { IntentCard } from "./IntentCard";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
});

const INTENT: IntentDetail = {
  pr_id: "pr-1",
  intent: "Introduce per-IP rate limiting on the public API endpoints.",
  in_scope: ["Token-bucket middleware", "Redis-backed counters"],
  out_of_scope: ["Auth changes", "Admin endpoints"],
  risk_areas: ["Auth surface touched", "New dependency: ioredis"],
  confidence: "high",
  sources: [{ kind: "pr_description", ref: "PR description", status: "fetched" }],
  model: "google/gemini-2.5-flash-lite",
  head_sha: "sha-1",
  generated_at: "2026-08-20T00:00:00.000Z",
  stale: false,
};

const RISKS: BriefRisk[] = [
  {
    kind: "security",
    // Deliberately different strings from INTENT.risk_areas so the tests can
    // tell the grounded rows apart from the free-text chips they replace.
    title: "Rate limiter precedes auth",
    explanation: "The limiter runs before the auth middleware, so unauthenticated bursts count.",
    severity: "high",
    refs: [
      { path: "src/middleware/ratelimit.ts", start_line: 12, end_line: 18 },
      { path: "src/server.ts", start_line: 88 },
    ],
  },
  {
    kind: "dependency",
    title: "Adds ioredis to the runtime deps",
    explanation: "Adds ioredis to the runtime dependency set.",
    severity: "medium",
    refs: [{ path: "package.json", start_line: 34 }],
  },
];

function renderCard(
  props: {
    prId?: string | null;
    headSha?: string | null;
    risks?: BriefRisk[];
    onGoToRef?: (path: string, line: number) => void;
  } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ brief: messages }}>
        <IntentCard
          prId={props.prId ?? "pr-1"}
          headSha={props.headSha ?? "sha-1"}
          risks={props.risks}
          onGoToRef={props.onGoToRef}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("IntentCard", () => {
  it("populated card renders the quoted summary, in/out scope columns, and risk-area chips", async () => {
    (api.get as Mock).mockResolvedValue(INTENT);
    renderCard();

    // Quoted italic summary.
    expect(
      await screen.findByText(/Introduce per-IP rate limiting on the public API endpoints\./),
    ).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("/pulls/pr-1/intent");

    // IN SCOPE / OUT OF SCOPE columns with their items.
    expect(screen.getByText("In scope")).toBeInTheDocument();
    expect(screen.getByText("Out of scope")).toBeInTheDocument();
    expect(screen.getByText("Token-bucket middleware")).toBeInTheDocument();
    expect(screen.getByText("Redis-backed counters")).toBeInTheDocument();
    expect(screen.getByText("Auth changes")).toBeInTheDocument();
    expect(screen.getByText("Admin endpoints")).toBeInTheDocument();

    // RISK AREAS chip row.
    expect(screen.getByText("Risk areas")).toBeInTheDocument();
    expect(screen.getByText("Auth surface touched")).toBeInTheDocument();
    expect(screen.getByText("New dependency: ioredis")).toBeInTheDocument();

    // High-confidence, fresh, fully-sourced → no warning badges; the manual
    // recompute button is always available on a populated card.
    expect(screen.queryByText("Low confidence")).not.toBeInTheDocument();
    expect(screen.queryByText("Stale — head moved")).not.toBeInTheDocument();
    expect(screen.queryByText(/Missing context/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Recompute intent/ })).toBeInTheDocument();
  });

  it("recompute on a fresh card triggers the mutation and re-renders the result", async () => {
    (api.get as Mock).mockResolvedValue(INTENT);
    (api.post as Mock).mockResolvedValue({
      ...INTENT,
      intent: "Recomputed: per-IP rate limiting on public endpoints.",
    });
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: /Recompute intent/ }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith("/pulls/pr-1/intent");
    });
    expect(api.post).toHaveBeenCalledTimes(1);
    // onSuccess seeds the cache with the fresh classification.
    expect(
      await screen.findByText(/Recomputed: per-IP rate limiting on public endpoints\./),
    ).toBeInTheDocument();
  });

  it("empty state (404): shows the CTA, click POSTs the classification and renders the result", async () => {
    (api.get as Mock).mockRejectedValue(
      Object.assign(new Error("Intent not found"), { status: 404 }),
    );
    (api.post as Mock).mockResolvedValue(INTENT);
    renderCard();

    // 404 → queries stay 4xx-silent → inline empty state with a CTA.
    expect(await screen.findByText("No intent classified yet.")).toBeInTheDocument();
    expect(
      screen.getByText("Classify this PR to derive its declared intent and scope for reviews."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Classify intent/ }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith("/pulls/pr-1/intent");
    });
    expect(api.post).toHaveBeenCalledTimes(1);
    // onSuccess seeds the query cache → the populated card replaces the empty state.
    expect(
      await screen.findByText(/Introduce per-IP rate limiting on the public API endpoints\./),
    ).toBeInTheDocument();
    expect(screen.queryByText("No intent classified yet.")).not.toBeInTheDocument();
  });

  it("low-confidence, missing-context and stale badges show; recompute triggers the mutation and clears stale", async () => {
    const staleIntent: IntentDetail = {
      ...INTENT,
      confidence: "low",
      head_sha: "old-sha",
      stale: true,
      sources: [
        { kind: "pr_description", ref: "PR description", status: "fetched" },
        { kind: "external_url", ref: "https://example.com/doc", status: "unavailable" },
      ],
    };
    (api.get as Mock).mockResolvedValue(staleIntent);
    (api.post as Mock).mockResolvedValue({ ...INTENT, head_sha: "sha-2" });
    renderCard({ headSha: "sha-2" });

    expect(await screen.findByText("Low confidence")).toBeInTheDocument();
    expect(screen.getByText("Stale — head moved")).toBeInTheDocument();
    expect(screen.getByText("Missing context: https://example.com/doc")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Recompute intent/ }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith("/pulls/pr-1/intent");
    });
    expect(api.post).toHaveBeenCalledTimes(1);
    // Fresh classification matches the current head → badges go away; the
    // recompute button stays (always available on a populated card).
    await waitFor(() => {
      expect(screen.queryByText("Stale — head moved")).not.toBeInTheDocument();
    });
    expect(screen.queryByText("Low confidence")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Recompute intent/ })).toBeInTheDocument();
  });

  // --- Risk Areas: brief risks replace the free-text chips (AC-22..AC-25) ---

  it("brief risks replace the free-text chips: every row shows a title and its primary file ref", async () => {
    (api.get as Mock).mockResolvedValue(INTENT);
    renderCard({ risks: RISKS });

    // Grounded rows, one per risk, each with a file ref.
    expect(await screen.findByText("Rate limiter precedes auth")).toBeInTheDocument();
    expect(screen.getByText("Adds ioredis to the runtime deps")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "src/middleware/ratelimit.ts:12-18" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "package.json:34" })).toBeInTheDocument();

    // …and none of the intent's free-text labels (AC-22).
    expect(screen.getByText("Risk areas")).toBeInTheDocument();
    expect(screen.queryByText("Auth surface touched")).not.toBeInTheDocument();
    expect(screen.queryByText("New dependency: ioredis")).not.toBeInTheDocument();
  });

  it("without brief risks the free-text chips render unchanged and no row is expandable (AC-23)", async () => {
    (api.get as Mock).mockResolvedValue(INTENT);
    // Empty array is treated the same as "no brief".
    renderCard({ risks: [] });

    expect(await screen.findByText("Auth surface touched")).toBeInTheDocument();
    expect(screen.getByText("New dependency: ioredis")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ratelimit\.ts/ })).not.toBeInTheDocument();
  });

  it("expanding a risk reveals its explanation and every ref; activating a ref navigates (AC-24, AC-25)", async () => {
    (api.get as Mock).mockResolvedValue(INTENT);
    const onGoToRef = vi.fn();
    renderCard({ risks: RISKS, onGoToRef });

    const toggle = (await screen.findAllByRole("button", { name: "Show details" }))[0]!;

    // Collapsed: primary ref only, explanation and the 2nd ref hidden.
    expect(screen.getByRole("button", { name: "src/middleware/ratelimit.ts:12-18" }))
      .toBeInTheDocument();
    expect(screen.getByText("+1 more")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "src/server.ts:88" })).not.toBeInTheDocument();
    expect(screen.queryByText(RISKS[0]!.explanation)).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);

    // Expanded: full explanation + both refs.
    expect(screen.getByText(RISKS[0]!.explanation)).toBeInTheDocument();
    const primary = screen.getByRole("button", { name: "src/middleware/ratelimit.ts:12-18" });
    const secondary = screen.getByRole("button", { name: "src/server.ts:88" });
    expect(screen.getByRole("button", { name: "Hide details" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    // Every ref hands its path + start line back to the page (AC-25).
    fireEvent.click(secondary);
    expect(onGoToRef).toHaveBeenCalledWith("src/server.ts", 88);
    fireEvent.click(primary);
    expect(onGoToRef).toHaveBeenCalledWith("src/middleware/ratelimit.ts", 12);
    expect(onGoToRef).toHaveBeenCalledTimes(2);

    // Collapsing hides them again — the other row is unaffected either way.
    fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
    expect(screen.queryByText(RISKS[0]!.explanation)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "src/server.ts:88" })).not.toBeInTheDocument();
  });
});
