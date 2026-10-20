import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { EvalCaseLink, FindingRecord } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/prReview.json";
import authMessages from "../../../../../../../../messages/en/auth.json";
import { FindingCard } from "./FindingCard";
import prHost from "../../../../../../../../messages/en/prHost.json";
import { FindingHostProvider } from "./host-context";
import type { HostLinkRepo } from "@/lib/host-urls";

// jsdom has no clipboard: stub it per test and put the original back after.
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

afterEach(() => {
  cleanup();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

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

/* --- GitLab: host links + copy finding (AC-37/38) ------------------------- */


const SHA = "0123abcd";
const RANGE: FindingRecord = { ...FINDING, start_line: 10, end_line: 20 };
const GITLAB: HostLinkRepo = {
  provider: "gitlab",
  host: "gitlab.com",
  web_url: "https://gitlab.com/space-profit/platform/crm-frontend",
  full_name: "space-profit/platform/crm-frontend",
};
const GITHUB: HostLinkRepo = {
  provider: "github",
  host: "github.com",
  web_url: "https://github.com/acme/payments-api",
  full_name: "acme/payments-api",
};

function renderHosted(repo: HostLinkRepo, offerCopy: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ prReview: messages, prHost }}>
      <FindingHostProvider value={{ repo, offerCopy }}>
        <FindingCard f={RANGE} defaultExpanded headSha={SHA} />
      </FindingHostProvider>
    </NextIntlClientProvider>,
  );
}

describe("FindingCard on a host", () => {
  it("GitLab: blob link, Copy finding writes the finding text, no post control or not-supported note", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    renderHosted(GITLAB, true);

    expect(screen.getByRole("link", { name: "src/config.ts:10-20" })).toHaveAttribute(
      "href",
      `https://gitlab.com/space-profit/platform/crm-frontend/-/blob/${SHA}/src/config.ts#L10-20`,
    );

    // AC-38: the card offers no "Post comment" (enabled or disabled) and no
    // "not supported" note — GitLab posting lives in the review flow.
    expect(screen.queryByRole("button", { name: "Post comment" })).not.toBeInTheDocument();
    expect(screen.queryByText(/isn't supported yet/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Copy finding" }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0]![0] as string;
    expect(text).toContain("Hardcoded Stripe secret key");
    expect(text).toContain("src/config.ts:10-20");
    expect(text).toContain("Move the key to an environment variable.");
  });

  it("GitHub: the same blob link as today, no Copy finding and no Post comment", () => {
    renderHosted(GITHUB, false);
    expect(screen.getByRole("link", { name: "src/config.ts:10-20" })).toHaveAttribute(
      "href",
      `https://github.com/acme/payments-api/blob/${SHA}/src/config.ts#L10-L20`,
    );
    expect(screen.queryByRole("button", { name: "Copy finding" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Post comment" })).not.toBeInTheDocument();
  });
});

describe("FindingCard — judgement attribution (AC-46, AC-48)", () => {
  function renderCard(f: React.ComponentProps<typeof FindingCard>["f"]) {
    return render(
      <NextIntlClientProvider locale="en" messages={{ prReview: messages, auth: authMessages }}>
        <FindingCard f={f} onAction={() => {}} />
      </NextIntlClientProvider>,
    );
  }

  it("shows who made the latest judgement: 'Dismissed by B' after A accepted, 'Local user' / '—' for legacy actors", () => {
    renderCard({
      ...FINDING,
      accepted_at: "2026-06-11T10:00:00.000Z",
      dismissed_at: "2026-06-11T11:00:00.000Z",
      acted_by: { user_id: "uB", name: "B" },
    });
    expect(screen.getByText("Dismissed by B")).toBeInTheDocument();
    expect(screen.queryByText(/Accepted by/)).not.toBeInTheDocument();
    cleanup();

    renderCard({
      ...FINDING,
      accepted_at: "2026-06-11T10:00:00.000Z",
      acted_by: { user_id: "sys", name: "System", is_system: true },
    });
    expect(screen.getByText("Accepted by Local user")).toBeInTheDocument();
    cleanup();

    renderCard({ ...FINDING, dismissed_at: "2026-06-11T10:00:00.000Z", acted_by: null });
    expect(screen.getByTitle("—")).toBeInTheDocument();
    cleanup();

    // Unjudged finding: no attribution even if the payload carries the key.
    renderCard({ ...FINDING, acted_by: null });
    expect(screen.queryByTitle("—")).not.toBeInTheDocument();
  });
});
