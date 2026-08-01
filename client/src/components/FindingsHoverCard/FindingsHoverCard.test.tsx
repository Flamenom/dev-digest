import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Finding } from "@devdigest/shared";
import messages from "../../../messages/en/prReview.json";
import { FindingsHoverCard, FindingsSeverityChips } from "./FindingsHoverCard";
import { countBySeverity } from "./helpers";

afterEach(cleanup);

const finding = (id: string, severity: Finding["severity"], title: string): Finding => ({
  id,
  severity,
  category: "security",
  title,
  file: "src/config.ts",
  start_line: 11,
  end_line: 11,
  rationale: "A live secret is committed in source.",
  suggestion: null,
  confidence: 0.95,
  kind: "finding",
  trifecta_components: null,
  evidence: null,
});

const FINDINGS: Finding[] = [
  finding("f1", "CRITICAL", "Hardcoded Stripe secret key"),
  finding("f2", "WARNING", "N+1 query in user list"),
];

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ prReview: messages }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("FindingsHoverCard", () => {
  it("renders one chip per non-zero severity with counts", () => {
    // CRITICAL:1 + WARNING:1 → two chips, each showing a count of 1.
    renderWithIntl(<FindingsSeverityChips counts={countBySeverity(FINDINGS)} />);
    expect(screen.getAllByText("1", { selector: ".tnum" })).toHaveLength(2);
  });

  it("reveals the findings list on hover", () => {
    const { container } = renderWithIntl(
      <FindingsHoverCard findings={FINDINGS} heading="2 findings">
        <FindingsSeverityChips counts={countBySeverity(FINDINGS)} />
      </FindingsHoverCard>,
    );
    // Card is closed initially.
    expect(screen.queryByText("Hardcoded Stripe secret key")).not.toBeInTheDocument();
    // Hovering the wrapper opens the card and lists the findings, most-severe first.
    fireEvent.mouseEnter(container.firstChild as Element);
    expect(screen.getByText("2 findings")).toBeInTheDocument();
    expect(screen.getByText("Hardcoded Stripe secret key")).toBeInTheDocument();
    expect(screen.getByText("N+1 query in user list")).toBeInTheDocument();
    expect(screen.getAllByText("src/config.ts:11")).toHaveLength(2);
  });

  it("shows a clean check when there are no findings", () => {
    const { container } = renderWithIntl(
      <FindingsSeverityChips counts={{ CRITICAL: 0, WARNING: 0, SUGGESTION: 0 }} />,
    );
    // No severity chips rendered; a single check icon stands in.
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});
