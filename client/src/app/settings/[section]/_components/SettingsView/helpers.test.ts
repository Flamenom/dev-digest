import { describe, it, expect } from "vitest";
import { formatDate, visibleSections } from "./helpers";

const t = (key: string) => `t:${key}`;

describe("visibleSections", () => {
  it("keeps local mode as today and adds Members + API tokens only in google mode", () => {
    expect(visibleSections("local", t).map((s) => s.key)).toEqual(["api-keys", "models"]);
    expect(visibleSections(null, t).map((s) => s.key)).toEqual(["api-keys", "models"]);
    expect(visibleSections("google", t)).toEqual([
      { key: "api-keys", label: "API Keys" },
      { key: "models", label: "Feature Models" },
      { key: "members", label: "t:members.navLabel" },
      { key: "api-tokens", label: "t:apiTokens.navLabel" },
    ]);
  });
});

describe("formatDate", () => {
  it("formats ISO timestamps and falls back for null/invalid", () => {
    expect(formatDate("2026-10-19T12:00:00.000Z", "—")).toBe("Oct 19, 2026");
    expect(formatDate(null, "Never")).toBe("Never");
    expect(formatDate("nope", "—")).toBe("—");
  });
});
