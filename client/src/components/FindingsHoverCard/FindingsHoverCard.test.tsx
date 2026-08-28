import { describe, it, expect, afterEach } from "vitest";
// NOTE: @testing-library/user-event is not a client devDependency; the whole
// suite interacts via fireEvent (see IntentCard/SmartDiffViewer tests). The
// keyboard flow below therefore drives real DOM focus inside `act` rather than
// adding a package from a test file.
import { render, screen, fireEvent, cleanup, within, act } from "@testing-library/react";
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

  it("opens from the keyboard, groups every finding by severity, and closes on Escape", () => {
    renderWithIntl(
      <FindingsHoverCard
        findings={[...FINDINGS, finding("f3", "WARNING", "Unbounded retry loop")]}
        heading="3 findings"
        triggerLabel="Show findings"
        groupBySeverity
        maxRows={Infinity}
      >
        <FindingsSeverityChips counts={countBySeverity(FINDINGS)} />
      </FindingsHoverCard>,
    );

    // The trigger is a real focusable control, and focusing it (what Tab does)
    // is enough to reveal the panel — no pointer needed.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "Show findings" });
    act(() => {
      trigger.focus();
    });
    const panel = screen.getByRole("dialog", { name: "3 findings" });

    // AC-20: every counted finding is listed, grouped by severity, and each row
    // carries its severity, title and file:line.
    expect(within(panel).getByText("Critical")).toBeInTheDocument();
    expect(within(panel).getByText("Warning")).toBeInTheDocument();
    expect(within(panel).getByText("Hardcoded Stripe secret key")).toBeInTheDocument();
    expect(within(panel).getByText("N+1 query in user list")).toBeInTheDocument();
    expect(within(panel).getByText("Unbounded retry loop")).toBeInTheDocument();
    expect(within(panel).getAllByText("src/config.ts:11")).toHaveLength(3);
    // Nothing is clipped behind a "+N more" cap.
    expect(within(panel).queryByText(/more/i)).not.toBeInTheDocument();

    // NFR-5: Escape dismisses it and focus lands back on the trigger. The
    // listener lives on `document` via the shared dialogStack, so the key is
    // dispatched there rather than on the panel.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("shows a clean check when there are no findings", () => {
    const { container } = renderWithIntl(
      <FindingsSeverityChips counts={{ CRITICAL: 0, WARNING: 0, SUGGESTION: 0 }} />,
    );
    // No severity chips rendered; a single check icon stands in.
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});
