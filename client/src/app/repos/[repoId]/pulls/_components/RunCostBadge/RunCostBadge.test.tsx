/**
 * RunCostBadge — cost formatting + the "no data" contract: null/undefined must
 * render an em dash, never "$0.00" (which would read as a free run).
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RunCostBadge } from "./RunCostBadge";
import { formatCost, formatCostCompact } from "./helpers";

afterEach(cleanup);

describe("RunCostBadge", () => {
  it("renders full cost (2 dp ≥ 1¢, 4 dp below)", () => {
    const { rerender } = render(<RunCostBadge usd={0.06} variant="full" />);
    expect(screen.getByText("$0.06")).toBeInTheDocument();
    rerender(<RunCostBadge usd={0.0013} variant="full" />);
    expect(screen.getByText("$0.0013")).toBeInTheDocument();
  });

  it("renders compact cost at 3 dp for the list cell", () => {
    render(<RunCostBadge usd={0.014} variant="compact" />);
    expect(screen.getByText("$0.014")).toBeInTheDocument();
  });

  it("renders an em dash — not $0.00 — when there is no cost", () => {
    const { rerender } = render(<RunCostBadge usd={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
    rerender(<RunCostBadge usd={undefined} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("cost formatters", () => {
  it("formatCost", () => {
    expect(formatCost(null)).toBe("—");
    expect(formatCost(undefined)).toBe("—");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.06)).toBe("$0.06");
    expect(formatCost(0.0013)).toBe("$0.0013");
    expect(formatCost(1.5)).toBe("$1.50");
  });

  it("formatCostCompact", () => {
    expect(formatCostCompact(null)).toBe("—");
    expect(formatCostCompact(0.014)).toBe("$0.014");
    expect(formatCostCompact(0.0003)).toBe("$0.0003");
  });
});
