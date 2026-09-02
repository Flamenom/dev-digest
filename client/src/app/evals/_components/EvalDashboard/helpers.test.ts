import { describe, it, expect } from "vitest";
import type { EvalBatchRecord } from "@devdigest/shared";
import { batchProgress, formatCost, formatMetric, isRunning, relativeTime } from "./helpers";

function batch(over: Partial<EvalBatchRecord> = {}): EvalBatchRecord {
  return {
    batch_id: "b1",
    agent_id: "ag1",
    agent_name: "Security Reviewer",
    agent_version: 7,
    ran_at: "2026-09-02T10:00:00.000Z",
    status: "complete",
    recall: 0.78,
    precision: 0.91,
    citation_accuracy: 1,
    cases_total: 20,
    cases_passed: 17,
    cases_failed: 2,
    cases_errored: 1,
    must_find_total: 14,
    must_find_matched: 11,
    must_not_flag_total: 6,
    noise_findings: 2,
    findings_total: 22,
    grounding_kept: 22,
    grounding_total: 22,
    duration_ms: 42_000,
    cost_usd: 0.1234,
    ...over,
  };
}

describe("EvalDashboard helpers", () => {
  it("renders a null metric as an em dash and never as a score (AC-21)", () => {
    expect(formatMetric(null)).toBe("—");
    expect(formatMetric(undefined)).toBe("—");
    expect(formatMetric(Number.NaN)).toBe("—");
    expect(formatMetric(0)).toBe("0%");
    expect(formatMetric(0.784)).toBe("78%");
    expect(formatMetric(1)).toBe("100%");

    // A batch with no recorded usage costs `null`, not $0.00 (AC-49).
    expect(formatCost(null)).toBe("—");
    expect(formatCost(0.1234)).toBe("$0.123");
  });

  it("derives batch progress from the finished cases and clamps it", () => {
    expect(batchProgress(batch({ cases_passed: 5, cases_failed: 1, cases_errored: 1 }))).toEqual({
      done: 7,
      total: 20,
      pct: 35,
    });
    // An empty batch must not divide by zero.
    expect(
      batchProgress(
        batch({ cases_total: 0, cases_passed: 0, cases_failed: 0, cases_errored: 0 }),
      ),
    ).toEqual({ done: 0, total: 0, pct: 0 });

    expect(isRunning(batch({ status: "running" }))).toBe(true);
    expect(isRunning(batch({ status: "complete" }))).toBe(false);
    expect(isRunning(null)).toBe(false);
  });

  it("formats a relative timestamp and passes through an unparseable one", () => {
    const now = new Date("2026-09-02T12:00:00.000Z");
    expect(relativeTime("2026-09-02T11:59:30.000Z", now)).toBe("just now");
    expect(relativeTime("2026-09-02T11:30:00.000Z", now)).toBe("30m ago");
    expect(relativeTime("2026-09-02T09:00:00.000Z", now)).toBe("3h ago");
    expect(relativeTime("2026-08-30T12:00:00.000Z", now)).toBe("3d ago");
    expect(relativeTime("not-a-date", now)).toBe("not-a-date");
  });
});
