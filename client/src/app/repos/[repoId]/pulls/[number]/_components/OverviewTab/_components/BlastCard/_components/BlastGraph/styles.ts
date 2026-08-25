import type { CSSProperties } from "react";

/** Layout constants for the layered SVG (viewBox units). */
export const GRAPH = {
  width: 640,
  colWidth: 200,
  colGap: 20,
  nodeHeight: 24,
  rowGap: 10,
  padY: 26,
  labelMaxChars: 24,
} as const;

export const s = {
  svgWrap: {
    width: "100%",
    overflowX: "auto",
  } satisfies CSSProperties,

  columnLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.07em",
    textTransform: "uppercase",
    fill: "var(--text-muted)",
  } satisfies CSSProperties,

  edge: {
    fill: "none",
    stroke: "var(--border-strong)",
    strokeWidth: 1,
    opacity: 0.7,
  } satisfies CSSProperties,

  node: (kind: "symbol" | "file" | "endpoint" | "cron"): CSSProperties => ({
    fill: "var(--bg-hover)",
    stroke: kind === "symbol" ? "var(--accent)" : kind === "file" ? "var(--border-strong)" : "var(--warn)",
    strokeWidth: 1,
    rx: 5,
  }),

  nodeText: (clickable: boolean): CSSProperties => ({
    fontSize: 11,
    fill: clickable ? "var(--accent)" : "var(--text-secondary)",
    cursor: clickable ? "pointer" : "default",
  }),

  empty: {
    fontSize: 12,
    color: "var(--text-muted)",
    padding: "10px 0",
  } satisfies CSSProperties,
} as const;
