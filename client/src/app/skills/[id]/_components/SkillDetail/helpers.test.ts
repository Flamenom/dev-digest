import { describe, it, expect } from "vitest";
import { diffLines } from "./helpers";

describe("diffLines (LCS line diff)", () => {
  it("marks everything same for identical bodies", () => {
    const out = diffLines("a\nb\nc", "a\nb\nc");
    expect(out).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
      { kind: "same", text: "c" },
    ]);
  });

  it("detects an added line", () => {
    const out = diffLines("a\nc", "a\nb\nc");
    expect(out).toEqual([
      { kind: "same", text: "a" },
      { kind: "added", text: "b" },
      { kind: "same", text: "c" },
    ]);
  });

  it("detects a removed line", () => {
    const out = diffLines("a\nb\nc", "a\nc");
    expect(out).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "same", text: "c" },
    ]);
  });

  it("renders a changed line as removed + added", () => {
    const out = diffLines("a\nold\nc", "a\nnew\nc");
    expect(out.filter((l) => l.kind === "removed")).toEqual([{ kind: "removed", text: "old" }]);
    expect(out.filter((l) => l.kind === "added")).toEqual([{ kind: "added", text: "new" }]);
    expect(out[0]).toEqual({ kind: "same", text: "a" });
    expect(out.at(-1)).toEqual({ kind: "same", text: "c" });
  });

  it("handles fully different bodies and empty strings", () => {
    expect(diffLines("", "x")).toEqual([
      { kind: "removed", text: "" },
      { kind: "added", text: "x" },
    ]);
    const out = diffLines("a\nb", "c\nd");
    expect(out.filter((l) => l.kind === "same")).toHaveLength(0);
    expect(out.filter((l) => l.kind === "removed").map((l) => l.text)).toEqual(["a", "b"]);
    expect(out.filter((l) => l.kind === "added").map((l) => l.text)).toEqual(["c", "d"]);
  });

  it("keeps the LCS anchored on common context", () => {
    const before = "intro\nrule 1\nrule 2\noutro";
    const after = "intro\nrule 1 (updated)\nrule 2\nrule 3\noutro";
    const out = diffLines(before, after);
    expect(out.map((l) => l.kind)).toEqual(["same", "removed", "added", "same", "added", "same"]);
  });
});
