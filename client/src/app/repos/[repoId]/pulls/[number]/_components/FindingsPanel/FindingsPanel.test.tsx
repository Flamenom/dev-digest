import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { FindingRecord } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/prReview.json";

vi.mock("@/lib/hooks/reviews", () => ({
  useFindingAction: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { FindingsPanel } from "./FindingsPanel";

afterEach(cleanup);

const FINDINGS: FindingRecord[] = [
  {
    id: "f1",
    severity: "CRITICAL",
    category: "security",
    title: "Hardcoded secret",
    file: "src/config.ts",
    start_line: 11,
    end_line: 11,
    rationale: "A secret is committed.",
    suggestion: null,
    confidence: 0.95,
    kind: "finding",
    trifecta_components: null,
    evidence: null,
    review_id: "r1",
    accepted_at: null,
    dismissed_at: null,
  },
];

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ prReview: messages }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("FindingsPanel (smoke)", () => {
  it("renders the toolbar + a finding card", () => {
    renderWithIntl(<FindingsPanel findings={FINDINGS} prId="pr1" />);
    expect(screen.getByText("Hide low confidence")).toBeInTheDocument();
    expect(screen.getByText("Hardcoded secret")).toBeInTheDocument();
  });

  it("shows the empty state when nothing matches", () => {
    renderWithIntl(<FindingsPanel findings={[]} prId="pr1" />);
    expect(screen.getByText("No findings match")).toBeInTheDocument();
  });
});

/* --- Smart Diff deep-link target (targetFindingId + nonce) ----------------- */

// Two findings: f1 (CRITICAL, high confidence, sorted first) and f2
// (SUGGESTION, LOW confidence — hidden by the "hide low confidence" filter).
const TWO_FINDINGS: FindingRecord[] = [
  FINDINGS[0]!,
  {
    id: "f2",
    severity: "SUGGESTION",
    category: "style",
    title: "Rename variable",
    file: "src/util.ts",
    start_line: 3,
    end_line: 3,
    rationale: "Name is unclear.",
    suggestion: null,
    confidence: 0.4, // below LOW_CONFIDENCE_THRESHOLD (0.65)
    kind: "finding",
    trifecta_components: null,
    evidence: null,
    review_id: "r1",
    accepted_at: null,
    dismissed_at: null,
  },
];

describe("FindingsPanel deep-link target", () => {
  it("focuses + scrolls to the target finding, and flips hide-low off when the target is filtered out", async () => {
    // jsdom has no scrollIntoView — record the receiver so we know WHICH card scrolled.
    const scrolled: HTMLElement[] = [];
    Element.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this);
    };

    const withIntl = (targetNonce?: number, targetFindingId?: string) => (
      <NextIntlClientProvider locale="en" messages={{ prReview: messages }}>
        <FindingsPanel
          findings={TWO_FINDINGS}
          prId="pr1"
          targetFindingId={targetFindingId ?? null}
          targetNonce={targetNonce ?? 0}
        />
      </NextIntlClientProvider>
    );

    const { rerender } = render(withIntl());
    expect(screen.getByText("Hardcoded secret")).toBeInTheDocument();
    expect(screen.getByText("Rename variable")).toBeInTheDocument();

    // Target f2 → its card gets the focused styling and is scrolled into view.
    rerender(withIntl(1, "f2"));
    await waitFor(() => expect(scrolled.length).toBe(1));
    const f2Card = scrolled[0]!;
    expect(f2Card.getAttribute("data-finding-id")).toBe("f2");
    expect(f2Card).toHaveTextContent("Rename variable");
    // Focused card styling: severity-coloured ring (s.card focused branch).
    expect(f2Card.style.boxShadow).toContain("0 0 0 1px");

    // User hides low-confidence findings → f2 (0.4) disappears.
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.queryByText("Rename variable")).not.toBeInTheDocument();

    // Re-targeting f2 (new nonce) flips the filter off, re-shows f2, and
    // scrolls to it again.
    rerender(withIntl(2, "f2"));
    await waitFor(() => expect(scrolled.length).toBe(2));
    expect(screen.getByText("Rename variable")).toBeInTheDocument();
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(scrolled[1]!.getAttribute("data-finding-id")).toBe("f2");
    expect(scrolled[1]!.style.boxShadow).toContain("0 0 0 1px");
  });
});
