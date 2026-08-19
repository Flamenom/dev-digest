import { describe, it, expect } from "vitest";
import type { Convention } from "@devdigest/shared";
import {
  defaultSkillDescription,
  defaultSkillName,
  evidenceLabel,
  generateSkillBody,
  relativeTime,
  slugifyRule,
} from "./helpers";

function convention(overrides: Partial<Convention> = {}): Convention {
  return {
    id: "c1",
    repo_id: "r1",
    category: "error-handling",
    rule: "Always use async/await instead of .then() chains",
    evidence_path: "src/api/users.ts",
    evidence_snippet: "const user = await db.users.find(id);",
    evidence_start_line: 23,
    evidence_end_line: 31,
    confidence: 0.91,
    status: "accepted",
    created_at: "2026-08-19T00:00:00Z",
    ...overrides,
  };
}

describe("slugifyRule", () => {
  it("kebab-cases the first ~6 words", () => {
    expect(slugifyRule("Always use async/await instead of .then() chains")).toBe(
      "always-use-async-await-instead-of-then",
    );
  });
  it("falls back for symbol-only rules", () => {
    expect(slugifyRule("!!!")).toBe("convention");
  });
});

describe("evidenceLabel", () => {
  it("renders path:start-end", () => {
    expect(evidenceLabel(convention())).toBe("src/api/users.ts:23-31");
  });
  it("collapses a single-line range", () => {
    expect(evidenceLabel(convention({ evidence_end_line: 23 }))).toBe("src/api/users.ts:23");
  });
  it("omits the line suffix when unresolved", () => {
    expect(
      evidenceLabel(convention({ evidence_start_line: null, evidence_end_line: null })),
    ).toBe("src/api/users.ts");
  });
});

describe("generateSkillBody", () => {
  it("renders header, intro, one section per convention with fenced evidence", () => {
    const body = generateSkillBody("acme/payments-api", [convention()]);
    expect(body).toContain("# payments-api-conventions");
    expect(body).toContain("House conventions for `acme/payments-api`.");
    expect(body).toContain("## always-use-async-await-instead-of-then");
    expect(body).toContain("Detected in `src/api/users.ts:23-31`:");
    expect(body).toContain("```ts\nconst user = await db.users.find(id);\n```");
  });

  it("dedupes slugs with a numeric suffix", () => {
    const body = generateSkillBody("acme/payments-api", [
      convention({ id: "c1" }),
      convention({ id: "c2" }),
    ]);
    expect(body).toContain("## always-use-async-await-instead-of-then\n");
    expect(body).toContain("## always-use-async-await-instead-of-then-2\n");
  });

  it("widens the fence when the snippet contains backticks", () => {
    const body = generateSkillBody("acme/payments-api", [
      convention({ evidence_snippet: "```js\nfenced\n```" }),
    ]);
    expect(body).toContain("````ts");
  });
});

describe("names + time", () => {
  it("defaultSkillName uses the repo short name", () => {
    expect(defaultSkillName("acme/payments-api")).toBe("payments-api-conventions");
  });
  it("defaultSkillDescription counts conventions", () => {
    expect(defaultSkillDescription("acme/payments-api", 3)).toBe(
      "3 house conventions extracted from payments-api",
    );
  });
  it("relativeTime buckets", () => {
    const now = new Date("2026-08-19T12:00:00Z");
    expect(relativeTime("2026-08-19T11:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-08-19T11:45:00Z", now)).toBe("15m ago");
    expect(relativeTime("2026-08-19T10:00:00Z", now)).toBe("2h ago");
    expect(relativeTime("2026-08-16T12:00:00Z", now)).toBe("3d ago");
  });
});
