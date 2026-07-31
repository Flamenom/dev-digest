/* RunCostBadge — the USD cost of one run, rendered as a single value span so
   it composes inside a Stat card, a PR-list cell, or a timeline line.
     - variant="compact" → dense 3-dp list cell ("$0.014")
     - variant="full"    → 2/4-dp everywhere else ("$0.06" / "$0.0013")
   No data (null/undefined) renders a muted "—", never "$0.00". */
"use client";

import React from "react";
import { formatCost, formatCostCompact } from "./helpers";
import { s } from "./styles";

export function RunCostBadge({
  usd,
  variant = "full",
}: {
  usd: number | null | undefined;
  variant?: "compact" | "full";
}) {
  if (usd == null) return <span style={s.muted}>—</span>;
  const text = variant === "compact" ? formatCostCompact(usd) : formatCost(usd);
  return (
    <span className="mono" style={s.cost}>
      {text}
    </span>
  );
}

export default RunCostBadge;
