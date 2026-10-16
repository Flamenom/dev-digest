import { describe, it, expect } from "vitest";
import type { EvalCaseRecord, EvalExpectedOutput } from "@devdigest/shared";
import {
  draftFromRecord,
  draftToInput,
  findExpectationWarnings,
  normalizeDiffPath,
  parseExpectedOutput,
  readCaseHasRunsCount,
  scanDiffHunks,
  sourceFindingState,
  withFindingSkeleton,
} from "./helpers";

/** Two hunks on the new side: [10,16] and [40,42]. */
const DIFF = [
  "diff --git a/src/config.ts b/src/config.ts",
  "--- a/src/config.ts",
  "+++ b/src/config.ts",
  "@@ -10,6 +10,7 @@ export const config = {",
  ' +  stripeKey: "sk_live_x",',
  "@@ -39,3 +40,3 @@ function boot() {",
  "   return config;",
].join("\n");

function expected(partial: Partial<EvalExpectedOutput> = {}): EvalExpectedOutput {
  return {
    kind: "must_find",
    expectations: [{ file: "src/config.ts", start_line: 12 }],
    ...partial,
  };
}

function record(over: Partial<EvalCaseRecord> = {}): EvalCaseRecord {
  return {
    id: "case-1",
    owner_kind: "agent",
    owner_id: "agent-1",
    name: "stripe-key-leak",
    input_diff: DIFF,
    input_files: null,
    input_meta: { title: "Add Stripe", body: "Wire payments", number: 42 },
    expected_output: expected(),
    source_finding_id: null,
    last_run: null,
    diff_warnings: [],
    ...over,
  };
}

describe("normalizeDiffPath", () => {
  it("applies the §4.1 pipeline and stays case-sensitive", () => {
    expect(normalizeDiffPath("b/src/config.ts")).toBe("src/config.ts");
    expect(normalizeDiffPath("a/src/config.ts")).toBe("src/config.ts");
    expect(normalizeDiffPath("  .\\src\\\\config.ts ")).toBe("src/config.ts");
    expect(normalizeDiffPath("/src//config.ts")).toBe("src/config.ts");
    // `a/` alone would leave nothing behind, so the prefix is kept (step 3).
    expect(normalizeDiffPath("a/")).toBe("a/");
    // Case is NOT folded — git is case-sensitive (§4.1).
    expect(normalizeDiffPath("SRC/Config.ts")).toBe("SRC/Config.ts");
  });
});

describe("scanDiffHunks", () => {
  it("reads the new-side start + count out of every @@ header", () => {
    expect(scanDiffHunks(DIFF)).toEqual({
      files: ["src/config.ts"],
      hunks: [
        { file: "src/config.ts", start: 10, end: 16 },
        { file: "src/config.ts", start: 40, end: 42 },
      ],
    });
  });

  it("defaults an omitted count to 1, skips pure deletions and /dev/null files", () => {
    const diff = [
      "+++ b/a.ts",
      "@@ -1 +7 @@",
      "+++ b/b.ts",
      "@@ -1,4 +1,0 @@",
      "+++ /dev/null",
      "@@ -1,2 +1,2 @@",
    ].join("\n");
    const scan = scanDiffHunks(diff);
    expect(scan.files).toEqual(["a.ts", "b.ts"]);
    expect(scan.hunks).toEqual([{ file: "a.ts", start: 7, end: 7 }]);
  });

  it("reports zero files for text that is not a diff", () => {
    expect(scanDiffHunks("just some pasted code\nnot a diff")).toEqual({ files: [], hunks: [] });
    expect(scanDiffHunks("")).toEqual({ files: [], hunks: [] });
  });
});

describe("parseExpectedOutput", () => {
  it("accepts a valid EvalExpectedOutput and rejects malformed or wrong-shaped JSON", () => {
    expect(parseExpectedOutput(JSON.stringify(expected())).ok).toBe(true);
    expect(parseExpectedOutput("{ kind: must_find }").ok).toBe(false);
    expect(parseExpectedOutput(JSON.stringify({ kind: "maybe", expectations: [] })).ok).toBe(false);
    expect(parseExpectedOutput(JSON.stringify({ expectations: [] })).ok).toBe(false);
  });
});

describe("findExpectationWarnings (AC-13)", () => {
  const scan = scanDiffHunks(DIFF);

  it("stays silent when every must_find range intersects a hunk of its own file", () => {
    expect(findExpectationWarnings(expected(), scan)).toEqual([]);
    // Boundary: a range that only touches the last line of a hunk still counts.
    const edge = expected({ expectations: [{ file: "src/config.ts", start_line: 16, end_line: 30 }] });
    expect(findExpectationWarnings(edge, scan)).toEqual([]);
  });

  it("warns for a range between hunks, for a wrong file, and normalizes lo/hi", () => {
    const between = expected({ expectations: [{ file: "b/src/config.ts", start_line: 30, end_line: 20 }] });
    expect(findExpectationWarnings(between, scan)).toEqual([
      { file: "b/src/config.ts", start: 20, end: 30 },
    ]);

    const wrongFile = expected({ expectations: [{ file: "src/other.ts", start_line: 12 }] });
    expect(findExpectationWarnings(wrongFile, scan)).toEqual([
      { file: "src/other.ts", start: 12, end: 12 },
    ]);
  });

  it("exempts must_not_flag cases and a null parse", () => {
    const noise = expected({ kind: "must_not_flag", expectations: [{ file: "x.ts", start_line: 900 }] });
    expect(findExpectationWarnings(noise, scan)).toEqual([]);
    expect(findExpectationWarnings(null, scan)).toEqual([]);
  });
});

describe("withFindingSkeleton", () => {
  it("appends to valid JSON, seeding the diff's first file + hunk", () => {
    const next = withFindingSkeleton(JSON.stringify(expected()), scanDiffHunks(DIFF));
    const parsed = parseExpectedOutput(next);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.expectations).toHaveLength(2);
    expect(parsed.value.expectations[1]).toEqual({
      file: "src/config.ts",
      start_line: 10,
      end_line: 16,
    });
  });

  it("recovers from unparseable text with a fresh valid must_find template", () => {
    const parsed = parseExpectedOutput(withFindingSkeleton("{{{", { files: [], hunks: [] }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.kind).toBe("must_find");
    expect(parsed.value.expectations).toHaveLength(1);
  });
});

describe("draftFromRecord / draftToInput", () => {
  it("round-trips a record and preserves provenance the editor does not expose", () => {
    const rec = record({ input_meta: { title: "T", body: "B", number: 42, author: "ada", base: "main" } });
    const draft = draftFromRecord(rec);
    expect(draft.name).toBe("stripe-key-leak");
    expect(draft.metaTitle).toBe("T");

    const body = draftToInput({ ...draft, metaTitle: "T2", metaBody: "" }, expected(), "agent-1", rec);
    expect(body.owner_kind).toBe("agent");
    expect(body.owner_id).toBe("agent-1");
    expect(body.input_meta).toEqual({
      title: "T2",
      body: null,
      number: 42,
      author: "ada",
      base: "main",
    });
  });

  it("seeds an empty, VALID expected_output for a new case", () => {
    const draft = draftFromRecord(null);
    expect(draft.name).toBe("");
    expect(parseExpectedOutput(draft.expectedText).ok).toBe(true);
  });
});

describe("readCaseHasRunsCount (AC-12)", () => {
  it("reads the run count off a 409 case_has_runs and ignores anything else", () => {
    expect(readCaseHasRunsCount({ status: 409, code: "case_has_runs", details: { run_count: 4 } })).toBe(4);
    expect(readCaseHasRunsCount({ status: 409, code: "case_has_runs", details: { runs: 2 } })).toBe(2);
    // The count is optional in the payload — never claim "0 recorded runs".
    expect(readCaseHasRunsCount({ status: 409, code: "case_has_runs" })).toBe(1);
    expect(readCaseHasRunsCount({ status: 404, code: "not_found" })).toBeNull();
    expect(readCaseHasRunsCount({ status: 409, code: "batch_already_running" })).toBeNull();
    expect(readCaseHasRunsCount(new Error("boom"))).toBeNull();
    expect(readCaseHasRunsCount(null)).toBeNull();
  });
});

describe("sourceFindingState", () => {
  it("links by PR number (never by uuid), degrades without a repo, and reports a dangling pointer", () => {
    const withFinding = record({ source_finding_id: "finding-7" });
    expect(sourceFindingState(withFinding, "repo-1")).toEqual({
      kind: "linked",
      href: "/repos/repo-1/pulls/42?tab=findings&finding=finding-7",
    });
    expect(sourceFindingState(withFinding, null).kind).toBe("plain");
    expect(sourceFindingState(record({ source_finding_id: "finding-7", input_meta: {} }), "repo-1").kind).toBe("gone");
    expect(sourceFindingState(record(), "repo-1").kind).toBe("none");
    expect(sourceFindingState(null, "repo-1").kind).toBe("none");
  });
});
