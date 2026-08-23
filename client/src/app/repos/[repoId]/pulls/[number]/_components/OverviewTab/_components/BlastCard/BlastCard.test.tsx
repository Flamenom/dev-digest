import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from "vitest";
// NOTE: @testing-library/user-event is not a client devDependency; the whole
// suite interacts via fireEvent (see IntentCard/SkillsTab tests) — we follow
// that pattern rather than adding a package from a test file.
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BlastResponse } from "@devdigest/shared";
import messages from "../../../../../../../../../../messages/en/blast.json";

// BlastCard talks to the API through lib/api only (via usePrBlast) — mock it
// wholesale so the real TanStack Query hook runs against fake fetches.
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

import { api } from "@/lib/api";
import { BlastCard } from "./BlastCard";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
});

/** Two changed symbols; first expanded by default, second collapsed. */
const OK: BlastResponse = {
  status: "ok",
  reason: null,
  counts: { symbols: 2, callers: 3, endpoints: 2, crons: 1 },
  symbols: [
    {
      symbol: { name: "roundCents", file: "src/money.ts", kind: "function" },
      callers: [
        { file: "src/routes/checkout.ts", line: 42, symbol: "checkoutHandler", rank: 0.9 },
        { file: "src/jobs/nightly.ts", line: 12, symbol: "nightlyJob", rank: 0.4 },
      ],
      endpoints_affected: ["POST /checkout"],
      crons_affected: ["0 3 * * *"],
    },
    {
      symbol: { name: "Money", file: "src/money.ts", kind: "class" },
      callers: [{ file: "src/routes/refund.ts", line: 8, symbol: "refundHandler", rank: 0.2 }],
      endpoints_affected: [],
      crons_affected: [],
    },
  ],
  endpoints: [
    { endpoint: "POST /checkout", file: "src/routes/checkout.ts", depth: 1 },
    { endpoint: "GET /health", file: "src/app.ts", depth: 2 }, // indirect (via imports)
  ],
  prior_prs: [
    {
      number: 471,
      title: "Refactor payment rounding",
      author: "dev",
      status: "merged",
      files_overlap: ["src/money.ts"],
    },
  ],
  summary: null,
};

const empty = (over: Partial<BlastResponse>): BlastResponse => ({
  status: "empty",
  reason: null,
  counts: { symbols: 0, callers: 0, endpoints: 0, crons: 0 },
  symbols: [],
  endpoints: [],
  prior_prs: [],
  summary: null,
  ...over,
});

function renderCard(props: { onGoToFile?: (file: string, line?: number) => void } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onGoToFile = props.onGoToFile ?? vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ blast: messages }}>
        <BlastCard prId="pr-1" repoFullName="acme/payments-api" onGoToFile={onGoToFile} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { onGoToFile };
}

describe("BlastCard", () => {
  it("loads: skeleton first, then counts, expanded first symbol, caller click → onGoToFile(file, line)", async () => {
    let resolve!: (v: BlastResponse) => void;
    (api.get as Mock).mockReturnValue(new Promise<BlastResponse>((r) => (resolve = r)));
    const { onGoToFile } = renderCard();

    // Loading: title only, no data yet (Skeleton has no content).
    expect(screen.getByText("Blast Radius")).toBeInTheDocument();
    expect(screen.queryByText(/callers/)).not.toBeInTheDocument();

    resolve(OK);

    // Header counts (symbols / callers / endpoints / cron-jobs).
    expect(await screen.findByText("symbols")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("/pulls/pr-1/blast");
    expect(screen.getByText("callers")).toBeInTheDocument();
    expect(screen.getByText("endpoints")).toBeInTheDocument();
    expect(screen.getByText("cron/jobs")).toBeInTheDocument();

    // First symbol starts EXPANDED: its callers and fact chips are visible.
    const first = screen.getByRole("button", { name: /roundCents/ });
    expect(first).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("2 callers")).toBeInTheDocument();
    expect(screen.getByText("POST /checkout")).toBeInTheDocument(); // endpoint chip
    expect(screen.getByText("0 3 * * *")).toBeInTheDocument(); // cron chip

    // Second symbol starts COLLAPSED: its caller is hidden until expanded.
    const second = screen.getByRole("button", { name: /Money/ });
    expect(second).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/refund\.ts:8/)).not.toBeInTheDocument();
    fireEvent.click(second);
    expect(second).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /src\/routes\/refund\.ts:8/ })).toBeInTheDocument();

    // Depth-2 endpoints render in the indirect "via imports" row.
    expect(screen.getByText("via imports:")).toBeInTheDocument();
    expect(screen.getByText("GET /health")).toBeInTheDocument();

    // file:line click delegates to the page-owned navigation callback.
    fireEvent.click(screen.getByRole("button", { name: /src\/routes\/checkout\.ts:42/ }));
    expect(onGoToFile).toHaveBeenCalledWith("src/routes/checkout.ts", 42);

    // Prior PRs footer: collapsed count → expand → GitHub PR deep-link + meta.
    const prior = screen.getByRole("button", { name: /Prior PRs touching these files/ });
    expect(prior).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(prior);
    const link = screen.getByRole("link", { name: "#471" });
    expect(link).toHaveAttribute("href", "https://github.com/acme/payments-api/pull/471");
    expect(screen.getByText("Refactor payment rounding")).toBeInTheDocument();
    expect(screen.getByText(/dev · merged · 1 shared files/)).toBeInTheDocument();
  });

  it("Tree|Graph toggle renders the layered SVG; a caller-file node click jumps to the file", async () => {
    (api.get as Mock).mockResolvedValue(OK);
    const { onGoToFile } = renderCard();

    const graphBtn = await screen.findByRole("button", { name: "graph" });
    expect(screen.getByRole("button", { name: "tree" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(graphBtn);
    expect(graphBtn).toHaveAttribute("aria-pressed", "true");

    const svg = screen.getByRole("img", { name: "Blast radius graph" });
    // Three column headers + symbol/file/impact nodes are drawn.
    expect(within(svg).getByText("Changed symbols")).toBeInTheDocument();
    expect(within(svg).getByText("Caller files")).toBeInTheDocument();
    expect(within(svg).getByText("Endpoints / crons")).toBeInTheDocument();
    expect(within(svg).getByText("roundCents()")).toBeInTheDocument();

    // Only caller-file nodes are clickable; clicking jumps without a line.
    const fileNode = within(svg)
      .getAllByRole("button")
      .find((n) => n.textContent?.includes("checkout.ts"));
    expect(fileNode).toBeDefined();
    fireEvent.click(fileNode!);
    expect(onGoToFile).toHaveBeenCalledWith("src/routes/checkout.ts");
  });

  it("zero-caller symbols collapse into a summary row; rows sort most-called first; graph skips them", async () => {
    // Silent symbols listed FIRST and least-called active symbol before the
    // most-called one — proves partition + callers-desc sorting, not payload order.
    (api.get as Mock).mockResolvedValue({
      ...OK,
      counts: { ...OK.counts, symbols: 4 },
      symbols: [
        {
          symbol: { name: "OutcomeProps", file: "src/types.ts", kind: "interface" },
          callers: [],
          endpoints_affected: [],
          crons_affected: [],
        },
        OK.symbols[1], // Money — 1 caller
        OK.symbols[0], // roundCents — 2 callers
        {
          symbol: { name: "tsOf", file: "src/util.ts", kind: "function" },
          callers: [],
          endpoints_affected: [],
          crons_affected: [],
        },
      ],
    });
    renderCard();

    // The most-called symbol is first and starts expanded despite payload order.
    expect(await screen.findByRole("button", { name: /roundCents/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: /Money/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    const rows = screen.getAllByRole("button", { name: /callers$/ });
    expect(rows[0]).toHaveTextContent("roundCents()");
    expect(rows[1]).toHaveTextContent("Money");

    // Zero-caller symbols get no rows — only the collapsed summary.
    expect(screen.queryByText("OutcomeProps")).not.toBeInTheDocument();
    expect(screen.queryByText("tsOf()")).not.toBeInTheDocument();
    const summary = screen.getByRole("button", { name: /2 symbols with no external callers/ });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(summary);
    expect(screen.getByText("OutcomeProps")).toBeInTheDocument();
    expect(screen.getByText("tsOf()")).toBeInTheDocument();

    // The graph draws active symbols only — no edge-less floating nodes.
    fireEvent.click(screen.getByRole("button", { name: "graph" }));
    const svg = screen.getByRole("img", { name: "Blast radius graph" });
    expect(within(svg).getByText("roundCents()")).toBeInTheDocument();
    expect(within(svg).queryByText("OutcomeProps")).not.toBeInTheDocument();
    expect(within(svg).queryByText(/tsOf/)).not.toBeInTheDocument();
  });

  it("empty state shows the no-symbols message with the server reason", async () => {
    (api.get as Mock).mockResolvedValue(
      empty({ status: "empty", reason: "no symbols are declared in the changed files." }),
    );
    renderCard();

    expect(
      await screen.findByText("No symbols declared in changed files."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("no symbols are declared in the changed files."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/callers/)).not.toBeInTheDocument();
  });

  it("degraded state shows the banner, reason, the index hint — and still lists prior PRs", async () => {
    (api.get as Mock).mockResolvedValue(
      empty({
        status: "degraded",
        reason: "the repository index is not built yet (degraded) — index the repository first.",
        prior_prs: OK.prior_prs,
      }),
    );
    renderCard();

    expect(await screen.findByText("Blast radius unavailable.")).toBeInTheDocument();
    expect(screen.getByText(/index is not built yet/)).toBeInTheDocument();
    expect(
      screen.getByText("Index the repository (repo-intel) to compute the blast radius."),
    ).toBeInTheDocument();
    // No tree/graph or counts — a declared state, not masked-as-empty data.
    expect(screen.queryByRole("button", { name: "graph" })).not.toBeInTheDocument();
    // Prior PRs are still local data and stay useful.
    expect(
      screen.getByRole("button", { name: /Prior PRs touching these files/ }),
    ).toBeInTheDocument();
  });

  it("partial state renders the warning banner AND the tree", async () => {
    (api.get as Mock).mockResolvedValue({
      ...OK,
      status: "partial",
      reason: "partial index (12 files indexed, 3 skipped) — results may be incomplete.",
    });
    renderCard();

    expect(
      await screen.findByText(/Partial index — results may be incomplete\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/12 files indexed, 3 skipped/)).toBeInTheDocument();
    // Data is still served under partial.
    expect(screen.getByRole("button", { name: /roundCents/ })).toBeInTheDocument();
  });

  it("4xx stays silent: inline unavailable state (client convention)", async () => {
    (api.get as Mock).mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));
    renderCard();

    expect(
      await screen.findByText("Blast radius is not available for this PR."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/callers/)).not.toBeInTheDocument();
  });
});
