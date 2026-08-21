import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
// NOTE: @testing-library/user-event is not a client devDependency — the whole
// suite interacts via fireEvent (see IntentCard/SkillsTab tests); we follow
// that convention rather than adding a package from a test file.
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { PrFile, ReviewRecord, SmartDiffResponse } from "@devdigest/shared";
import prReview from "../../../../../../../../messages/en/prReview.json";
import shell from "../../../../../../../../messages/en/shell.json";

// DiffTab reads comments via reviews hooks and the smart-diff payload via
// usePrSmartDiff — mock both hook modules (established suite pattern), so no
// QueryClient / fetch is involved.
vi.mock("@/lib/hooks/reviews", () => ({
  usePrComments: () => ({ data: [] }),
  useCreatePrComment: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/hooks/smart-diff", () => ({
  usePrSmartDiff: vi.fn(),
}));

import { usePrSmartDiff } from "@/lib/hooks/smart-diff";
import { DiffTab } from "./DiffTab";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
});

/* --- Fixtures ------------------------------------------------------------ */

// NEW line 2 is the annotated line (`const secret = "sk-live";`).
const CORE_PATCH = [
  "@@ -1,3 +1,5 @@",
  " const a = 1;",
  '+const secret = "sk-live";',
  "+use(secret);",
  " const b = 2;",
].join("\n");

const FILES: PrFile[] = [{ path: "src/core.ts", additions: 2, deletions: 0, patch: CORE_PATCH }];

const SMART_DIFF: SmartDiffResponse = {
  groups: [
    {
      role: "core",
      files: [
        {
          path: "src/core.ts",
          pseudocode_summary: null,
          additions: 2,
          deletions: 0,
          finding_lines: [2],
        },
      ],
    },
    { role: "wiring", files: [] },
    { role: "boilerplate", files: [] },
  ],
  split_suggestion: { too_big: false, total_lines: 2, proposed_splits: [] },
};

const REVIEWS: ReviewRecord[] = [
  {
    id: "r1",
    pr_id: "pr1",
    agent_id: "a1",
    run_id: "run1",
    kind: "review",
    verdict: null,
    summary: null,
    score: null,
    model: null,
    created_at: "2026-08-01T00:00:00Z",
    findings: [
      {
        id: "f-live",
        severity: "CRITICAL",
        category: "security",
        title: "Hardcoded secret",
        file: "src/core.ts",
        start_line: 2,
        end_line: 2,
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
    ],
  },
];

type SmartQuery = ReturnType<typeof usePrSmartDiff>;

function mockSmartDiff(overrides: Partial<SmartQuery> = {}) {
  vi.mocked(usePrSmartDiff).mockReturnValue({
    data: SMART_DIFF,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    ...overrides,
  } as unknown as SmartQuery);
}

function renderTab(onGoToFinding?: (id: string) => void) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ prReview, shell }}>
      <DiffTab
        prId="pr1"
        filesCount={FILES.length}
        files={FILES}
        reviews={REVIEWS}
        onGoToFinding={onGoToFinding}
      />
    </NextIntlClientProvider>,
  );
}

/* --- Tests ---------------------------------------------------------------- */

describe("DiffTab", () => {
  it("defaults to Smart order, toggles to Original (plain viewer, no overlays) and back", () => {
    mockSmartDiff();
    renderTab();

    // Default mode is Smart: the smart-diff hook is enabled and the role
    // sections + severity overlay render.
    expect(vi.mocked(usePrSmartDiff)).toHaveBeenLastCalledWith("pr1", true);
    expect(screen.getByText("Core")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open this CRITICAL finding in Agent runs" }),
    ).toBeInTheDocument();
    // The segmented toggle marks the selected mode as pressed.
    expect(screen.getByRole("button", { name: "Smart order" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Original order" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // Toggle to Original order → plain DiffViewer: same file content, but the
    // role sections and severity overlays are GONE.
    fireEvent.click(screen.getByRole("button", { name: "Original order" }));
    expect(screen.getByRole("button", { name: "Original order" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Smart order" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByText("src/core.ts")).toBeInTheDocument();
    expect(screen.getByText('const secret = "sk-live";')).toBeInTheDocument();
    expect(screen.queryByText("Core")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /finding in agent runs/i }),
    ).not.toBeInTheDocument();
    // The smart-diff fetch is gated off while Original order is active.
    expect(vi.mocked(usePrSmartDiff)).toHaveBeenLastCalledWith("pr1", false);

    // Toggle back to Smart order → Smart view restored (sections + overlay).
    fireEvent.click(screen.getByRole("button", { name: "Smart order" }));
    expect(screen.getByText("Core")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open this CRITICAL finding in Agent runs" }),
    ).toBeInTheDocument();
    expect(vi.mocked(usePrSmartDiff)).toHaveBeenLastCalledWith("pr1", true);
  });

  it("shows the smart-diff error state with a working Retry", () => {
    const refetch = vi.fn();
    mockSmartDiff({ data: undefined, isError: true, refetch } as Partial<SmartQuery>);
    renderTab();

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load the smart diff");
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
