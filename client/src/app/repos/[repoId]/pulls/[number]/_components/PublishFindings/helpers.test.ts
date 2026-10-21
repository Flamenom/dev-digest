/* helpers (pure): the URL guard, the tri-state, and the dialog's counts. */
import { describe, it, expect } from "vitest";
import { isSafeHttpUrl, selectedFindings, selectionState, summarizeSelection } from "./helpers";
import { previewEntry } from "./test-fixtures";

describe("publish helpers", () => {
  it("accepts only absolute http/https URLs", () => {
    expect(isSafeHttpUrl("https://gitlab.com/a/-/merge_requests/1#note_2")).toBe(true);
    expect(isSafeHttpUrl("http://gitlab.local/x")).toBe(true);
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "/relative", "", null, undefined]) {
      expect(isSafeHttpUrl(bad)).toBe(false);
    }
  });

  it("derives the tri-state and joins severities in preview order", () => {
    expect(selectionState(0, 3)).toBe("none");
    expect(selectionState(1, 3)).toBe("some");
    expect(selectionState(3, 3)).toBe("all");
    expect(selectionState(0, 0)).toBe("none");

    const preview = [
      previewEntry("a", { suggestion_eligible: true }),
      previewEntry("b", { anchor: { kind: "general", path: "x", start_line: 1, end_line: 1, off_diff_reason: "patch_unavailable" } }),
      previewEntry("c"),
    ];
    const joined = selectedFindings(preview, new Set(["c", "a", "b", "zz"]), [
      { id: "a", severity: "CRITICAL" },
      { id: "b", severity: "SUGGESTION" },
      { id: "c", severity: "SUGGESTION" },
    ]);
    expect(joined.map((j) => j.entry.finding_id)).toEqual(["a", "b", "c"]);
    expect(summarizeSelection(joined)).toEqual({
      bySeverity: { CRITICAL: 1, WARNING: 0, SUGGESTION: 2 },
      general: 1,
      suggestionEligible: 1,
    });
  });
});
