import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from "vitest";
// NOTE: @testing-library/user-event is not a client devDependency; the whole
// suite interacts via fireEvent (see SkillsTab/ConventionsView tests) — we
// follow that pattern rather than adding a package from a test file.
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IntentDetail } from "@devdigest/shared";
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

function renderCard(props: { prId?: string | null; headSha?: string | null } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ brief: messages }}>
        <IntentCard prId={props.prId ?? "pr-1"} headSha={props.headSha ?? "sha-1"} />
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
});
