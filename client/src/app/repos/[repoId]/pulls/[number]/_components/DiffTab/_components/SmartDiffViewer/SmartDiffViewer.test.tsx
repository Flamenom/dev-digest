import { describe, it, expect, afterEach, vi } from "vitest";
// NOTE: @testing-library/user-event is not a client devDependency — the whole
// suite interacts via fireEvent (see IntentCard/SkillsTab tests); we follow
// that convention rather than adding a package from a test file.
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { PrFile, ReviewRecord, SmartDiffResponse } from "@devdigest/shared";
import prReview from "../../../../../../../../../../messages/en/prReview.json";
import shell from "../../../../../../../../../../messages/en/shell.json";
import { SmartDiffViewer } from "./SmartDiffViewer";

afterEach(cleanup);

/* --- Fixtures ------------------------------------------------------------ */

// Unified diff: NEW line 2 is `const secret = "sk-live";` (the finding anchor).
const CORE_PATCH = [
  "@@ -1,3 +1,5 @@",
  " const a = 1;",
  '+const secret = "sk-live";',
  "+use(secret);",
  " const b = 2;",
].join("\n");

const WIRING_PATCH = ["@@ -1,1 +1,2 @@", ' import x from "x";', "+wireItUp();"].join("\n");

const FILES: PrFile[] = [
  { path: "src/core.ts", additions: 4, deletions: 1, patch: CORE_PATCH },
  { path: "src/wiring.ts", additions: 700, deletions: 2, patch: WIRING_PATCH },
];

const SMART_DIFF: SmartDiffResponse = {
  groups: [
    {
      role: "core",
      files: [
        {
          path: "src/core.ts",
          pseudocode_summary: null,
          additions: 4,
          deletions: 1,
          finding_lines: [2],
        },
      ],
    },
    {
      role: "wiring",
      files: [
        {
          path: "src/wiring.ts",
          pseudocode_summary: null,
          additions: 700,
          deletions: 2,
          finding_lines: [],
        },
      ],
    },
    {
      role: "boilerplate",
      files: [
        {
          path: "gen/types.ts",
          pseudocode_summary: null,
          additions: 100,
          deletions: 0,
          finding_lines: [],
        },
      ],
    },
  ],
  split_suggestion: {
    too_big: true,
    total_lines: 950,
    proposed_splits: [
      { name: "core-change", files: ["src/core.ts", "src/wiring.ts"] },
      { name: "generated", files: ["gen/types.ts"] },
    ],
  },
};

// One review with 2 findings on src/core.ts — one live (CRITICAL, new line 2),
// one dismissed (WARNING, new line 3). Only the live one may surface anywhere.
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
      {
        id: "f-dead",
        severity: "WARNING",
        category: "bug",
        title: "Dismissed one",
        file: "src/core.ts",
        start_line: 3,
        end_line: 3,
        rationale: "Already dismissed by the user.",
        suggestion: null,
        confidence: 0.9,
        kind: "finding",
        trifecta_components: null,
        evidence: null,
        review_id: "r1",
        accepted_at: null,
        dismissed_at: "2026-08-02T00:00:00Z",
      },
    ],
  },
];

function renderViewer(onFindingClick?: (id: string) => void) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ prReview, shell }}>
      <SmartDiffViewer
        smartDiff={SMART_DIFF}
        files={FILES}
        reviews={REVIEWS}
        onFindingClick={onFindingClick}
      />
    </NextIntlClientProvider>,
  );
}

/* --- Tests ---------------------------------------------------------------- */

describe("SmartDiffViewer", () => {
  it("renders the 3 role sections with stats and split hint; Boilerplate stays collapsed until clicked", () => {
    renderViewer();

    // Stat header sums all groups: 3 files, +804 −3 (U+2212 minus from the message).
    expect(screen.getByText("3 files +804 −3")).toBeInTheDocument();

    // All three sections render label + subtitle + "N files" count.
    expect(screen.getByText("Core")).toBeInTheDocument();
    expect(screen.getByText("The substance of the change — review closely")).toBeInTheDocument();
    expect(screen.getByText("Wiring")).toBeInTheDocument();
    expect(screen.getByText("Hooks the core into the app")).toBeInTheDocument();
    expect(screen.getByText("Boilerplate")).toBeInTheDocument();
    expect(screen.getByText("Generated / mechanical — skim")).toBeInTheDocument();
    // One "1 files" count per section (the split hint contributes another).
    expect(screen.getAllByText("1 files").length).toBeGreaterThanOrEqual(3);

    // Split hint: too_big → title with total lines + the proposed split names.
    expect(screen.getByText("This PR is large (950 changed lines)")).toBeInTheDocument();
    expect(screen.getByText("core-change")).toBeInTheDocument();
    expect(screen.getByText("generated")).toBeInTheDocument();
    expect(screen.getByText("2 files")).toBeInTheDocument();

    // Large-file header hint on the 702-changed-lines wiring file.
    expect(screen.getByText("Large file — 702 changed lines")).toBeInTheDocument();

    // Boilerplate section is collapsed by default — its file is hidden…
    expect(screen.queryByText("gen/types.ts")).not.toBeInTheDocument();
    // …until the user clicks the section header.
    fireEvent.click(screen.getByRole("button", { name: /boilerplate/i }));
    expect(screen.getByText("gen/types.ts")).toBeInTheDocument();
  });

  it("auto-expands the file with findings, overlays the annotated line, excludes dismissed from the badge, and navigates on badge click", () => {
    const onFindingClick = vi.fn();
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    renderViewer(onFindingClick);

    // File WITH findings auto-expands: its annotated added line is visible.
    expect(screen.getByText('const secret = "sk-live";')).toBeInTheDocument();
    // File WITHOUT findings stays collapsed: its patch lines are hidden.
    expect(screen.queryByText("wireItUp();")).not.toBeInTheDocument();

    // "N findings" badge counts only non-dismissed findings (1, not 2).
    expect(screen.getByText("1 finding(s)")).toBeInTheDocument();
    expect(screen.queryByText("2 finding(s)")).not.toBeInTheDocument();

    // Exactly ONE severity overlay (the dismissed WARNING paints nothing).
    const badges = screen.getAllByRole("button", { name: /finding in agent runs/i });
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveAccessibleName("Open this CRITICAL finding in Agent runs");

    // Clicking the badge calls the navigation callback with the finding id —
    // no popup, no GitHub link (locked requirements).
    fireEvent.click(badges[0]!);
    expect(onFindingClick).toHaveBeenCalledTimes(1);
    expect(onFindingClick).toHaveBeenCalledWith("f-live");
    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    openSpy.mockRestore();
  });
});
