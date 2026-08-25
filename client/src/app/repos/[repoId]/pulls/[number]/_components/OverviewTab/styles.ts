import type { CSSProperties } from "react";

export const s = {
  // Intent | Blast two-column grid; auto-fit collapses to one column when the
  // viewport can't hold two 340px tracks (inline styles have no media queries).
  cardsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
    gap: 24,
    alignItems: "stretch",
  } satisfies CSSProperties,

  descriptionBox: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-elevated)",
    padding: 18,
    fontSize: 14,
    color: "var(--text-secondary)",
    whiteSpace: "pre-wrap",
    lineHeight: 1.55,
  } satisfies CSSProperties,
} as const;
