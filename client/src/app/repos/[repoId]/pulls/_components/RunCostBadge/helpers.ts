/* Pure USD-cost formatters for RunCostBadge. Null/undefined → "—" (never
   "$0.00"), so a run with no cost data reads as absent rather than free. */

/** Full cost — trace-drawer Stats card + timeline row. 2 dp ≥ 1¢, else 4 dp. */
export function formatCost(usd: number | null | undefined): string {
  if (usd == null) return "—";
  if (usd === 0) return "$0.00";
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/** Compact cost — the dense PR-list COST cell. 3 dp (e.g. "$0.014"). */
export function formatCostCompact(usd: number | null | undefined): string {
  if (usd == null) return "—";
  if (usd === 0) return "$0.00";
  return usd >= 0.001 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(4)}`;
}
