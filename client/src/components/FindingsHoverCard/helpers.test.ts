import { describe, it, expect } from "vitest";
import { countBySeverity, totalCount } from "./helpers";

const f = (severity: string) => ({ severity } as { severity: string });

describe("countBySeverity", () => {
  it("tallies each severity independently", () => {
    const counts = countBySeverity([
      f("CRITICAL"),
      f("CRITICAL"),
      f("WARNING"),
      f("SUGGESTION"),
      f("SUGGESTION"),
      f("SUGGESTION"),
    ] as never);
    expect(counts).toEqual({ CRITICAL: 2, WARNING: 1, SUGGESTION: 3 });
    expect(totalCount(counts)).toBe(6);
  });

  it("returns all zeros for an empty list", () => {
    const counts = countBySeverity([]);
    expect(counts).toEqual({ CRITICAL: 0, WARNING: 0, SUGGESTION: 0 });
    expect(totalCount(counts)).toBe(0);
  });

  it("ignores unknown severities", () => {
    const counts = countBySeverity([f("INFO"), f("CRITICAL")] as never);
    expect(counts).toEqual({ CRITICAL: 1, WARNING: 0, SUGGESTION: 0 });
  });
});
