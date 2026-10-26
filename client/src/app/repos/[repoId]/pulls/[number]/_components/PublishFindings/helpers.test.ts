/* helpers (pure): the URL guard, the tri-state, the dialog's counts, and the
   outdated-run helpers + i18n catalog (spec 2026-10-23, AC-19 – AC-24). */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  DEPRECATION_409_CODES,
  isSafeHttpUrl,
  previewDeprecation,
  selectedFindings,
  selectionState,
  shortSha,
  summarizeSelection,
} from "./helpers";
import { deferredEntry, deprecatedPreview, previewEntry, REVIEWED_SHA } from "./test-fixtures";

// `__dirname` (vite-node injects it) → client/messages/en/prHost.json
const PR_HOST_JSON = resolve(__dirname, "../../../../../../../../messages/en/prHost.json");

/** Every string C1 adds under `prHost.publish` (spec D-17). */
const NEW_PUBLISH_KEYS = [
  "deferredAnchor",
  "publishedDeprecatedBy",
  "deprecation.notice.headMoved",
  "deprecation.notice.headUnknown",
  "dialog.outdated.heading",
  "dialog.outdated.headMoved",
  "dialog.outdated.headUnknown",
  "dialog.outdated.placementSome",
  "dialog.outdated.placementAll",
  "dialog.outdated.planUnavailable",
  "dialog.outdated.noApplicable",
  "dialog.publishDeprecated",
  "result.publishedDeprecated",
  "result.generalCount",
] as const;

function lookup(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
    obj,
  );
}

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
      deferred: 0,
      suggestionEligible: 1,
    });
  });

  it("counts deferred anchors as neither positioned nor general and reads the deprecation", () => {
    const preview = deprecatedPreview("head_moved", ["a", "b"]);
    const joined = selectedFindings(preview.findings, new Set(["a", "b"]), [
      { id: "a", severity: "WARNING" },
      { id: "b", severity: "CRITICAL" },
    ]);
    expect(summarizeSelection(joined)).toMatchObject({ general: 0, deferred: 2, suggestionEligible: 0 });
    expect(summarizeSelection(selectedFindings([deferredEntry("x")], new Set(["x"]), [{ id: "x", severity: "SUGGESTION" }])).deferred).toBe(1);

    expect(previewDeprecation(preview)).toEqual({ reason: "head_moved", reviewed_head_sha: REVIEWED_SHA });
    expect(previewDeprecation(deprecatedPreview("head_unknown"))?.reason).toBe("head_unknown");
    expect(previewDeprecation({ deprecation: null })).toBeNull();
    expect(previewDeprecation(undefined)).toBeNull();

    expect([...DEPRECATION_409_CODES].sort()).toEqual(["review_diff_outdated", "review_head_unknown"]);
  });

  it("shortens only lowercase-hex SHAs to 8 characters", () => {
    expect(shortSha("abcdef1234567890")).toBe("abcdef12");
    expect(shortSha(REVIEWED_SHA)).toBe("abcdef12");
    for (const bad of ["XYZ", "ABCDEF1234567890", "abc12", "abcdef12-zz", "", null, undefined]) {
      expect(shortSha(bad), String(bad)).toBeNull();
    }
  });

  it("ships every outdated-run string in prHost.json, with the AC-4 409 message", () => {
    const catalog = JSON.parse(readFileSync(PR_HOST_JSON, "utf8")) as { publish: unknown };
    for (const key of NEW_PUBLISH_KEYS) {
      expect(lookup(catalog.publish, key), key).toEqual(expect.any(String));
    }
    const ack = "This review is outdated — confirm publishing its findings as deprecated.";
    expect(lookup(catalog.publish, "code.review_diff_outdated")).toBe(ack);
    expect(lookup(catalog.publish, "code.review_head_unknown")).toBe(ack);
    expect(lookup(catalog.publish, "deferredAnchor")).toBe("Placement decided at publish (outdated review)");
  });
});
