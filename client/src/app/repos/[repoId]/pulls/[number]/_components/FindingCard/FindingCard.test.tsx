import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { EvalCaseLink, FindingRecord } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/prReview.json";
import { FindingCard } from "./FindingCard";

afterEach(cleanup);

const FINDING: FindingRecord = {
  id: "f1",
  severity: "CRITICAL",
  category: "security",
  title: "Hardcoded Stripe secret key",
  file: "src/config.ts",
  start_line: 11,
  end_line: 11,
  rationale: "A **live** Stripe key is committed in source.",
  suggestion: "Move the key to an environment variable.",
  confidence: 0.95,
  kind: "finding",
  trifecta_components: null,
  evidence: null,
  review_id: "r1",
  accepted_at: null,
  dismissed_at: null,
};

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ prReview: messages }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("FindingCard (smoke, both themes)", () => {
  (["dark", "light"] as const).forEach((theme) => {
    it(`renders severity + file:line + rationale in ${theme}`, () => {
      renderWithIntl(
        <div data-theme={theme}>
          <FindingCard f={FINDING} defaultExpanded onAction={() => {}} />
        </div>,
      );
      expect(screen.getByText("Hardcoded Stripe secret key")).toBeInTheDocument();
      expect(screen.getByText("src/config.ts:11")).toBeInTheDocument();
      // category label is shown alongside the severity badge
      expect(screen.getByText("security")).toBeInTheDocument();
    });
  });

  it("fires accept/dismiss actions", () => {
    const onAction = vi.fn();
    renderWithIntl(<FindingCard f={FINDING} defaultExpanded onAction={onAction} />);
    fireEvent.click(screen.getByText("Accept"));
    expect(onAction).toHaveBeenCalledWith("accept");
    fireEvent.click(screen.getByText("Dismiss"));
    expect(onAction).toHaveBeenCalledWith("dismiss");
  });
});

/* --- L06 screen A: turn a judged finding into an eval case ----------------- */

const ACCEPTED: FindingRecord = { ...FINDING, accepted_at: "2026-09-01T10:00:00.000Z" };

/** The `GET /pulls/:id/eval-cases` payload FindingsPanel joins by finding id. */
const EVAL_CASE_LINKS: EvalCaseLink[] = [
  { finding_id: "f1", case_id: "c9", case_name: "stripe-key-leak" },
];

describe("FindingCard eval case action", () => {
  it("keeps the button disabled with an accessible reason until the finding is judged", () => {
    renderWithIntl(<FindingCard f={FINDING} defaultExpanded />);

    const btn = screen.getByRole("button", { name: "Turn into eval case" });
    expect(btn).toBeDisabled();
    // aria-label/title alone would not reach a screen reader on a disabled
    // control — the reason must be the accessible DESCRIPTION (AC-7).
    expect(btn).toHaveAccessibleDescription("Accept or dismiss this finding first");
  });

  it("asks the panel to open the editor on click, and stays on the page", () => {
    const onOpenEvalCase = vi.fn();
    renderWithIntl(<FindingCard f={ACCEPTED} defaultExpanded onOpenEvalCase={onOpenEvalCase} />);

    const btn = screen.getByRole("button", { name: "Turn into eval case" });
    expect(btn).toBeEnabled();
    expect(btn).not.toHaveAccessibleDescription();

    fireEvent.click(btn);
    expect(onOpenEvalCase).toHaveBeenCalledTimes(1);
    // Nothing navigates: the editor opens in place and the case is written by
    // its Save, so the card must not offer a link out of the PR.
    expect(screen.queryByRole("link", { name: /Eval case/ })).not.toBeInTheDocument();
  });

  it("shows the created state only once a case exists, and opens it in place", () => {
    const link = EVAL_CASE_LINKS.find((l) => l.finding_id === ACCEPTED.id) ?? null;
    const onOpenEvalCase = vi.fn();
    renderWithIntl(
      <FindingCard
        f={ACCEPTED}
        defaultExpanded
        evalCaseLink={link}
        onOpenEvalCase={onOpenEvalCase}
      />,
    );

    expect(screen.queryByRole("button", { name: "Turn into eval case" })).not.toBeInTheDocument();
    const created = screen.getByRole("button", { name: /Eval case/ });
    expect(screen.queryByRole("link", { name: /Eval case/ })).not.toBeInTheDocument();

    fireEvent.click(created);
    expect(onOpenEvalCase).toHaveBeenCalledTimes(1);
  });
});
