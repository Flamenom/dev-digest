import { describe, it, expect } from "vitest";
import { formatTokensAbbrev } from "./format";

/* formatTokensAbbrev is what the PR brief renders for input → output token
   counts, so these pin the exact strings the spec calls out (AC-42) plus the
   "absent value is an em dash, never 0" rule shared with the cost badge
   (AC-19). */

describe("formatTokensAbbrev", () => {
  it("abbreviates each magnitude the way the brief displays it", () => {
    // millions and thousands collapse to one decimal…
    expect(formatTokensAbbrev(1_240_000)).toBe("1.2M");
    expect(formatTokensAbbrev(8231)).toBe("8.2K");
    expect(formatTokensAbbrev(1340)).toBe("1.3K");
    // …while sub-thousand counts stay verbatim, no suffix, no decimal.
    expect(formatTokensAbbrev(940)).toBe("940");
    expect(formatTokensAbbrev(0)).toBe("0");
  });

  it("renders an em dash for an absent count rather than a zero", () => {
    expect(formatTokensAbbrev(null)).toBe("—");
    expect(formatTokensAbbrev(undefined)).toBe("—");
    expect(formatTokensAbbrev(Number.NaN)).toBe("—");
  });

  it("switches suffix exactly at each threshold", () => {
    expect(formatTokensAbbrev(999)).toBe("999");
    expect(formatTokensAbbrev(1000)).toBe("1.0K");
    expect(formatTokensAbbrev(999_999)).toBe("1000.0K");
    expect(formatTokensAbbrev(1_000_000)).toBe("1.0M");
  });
});
