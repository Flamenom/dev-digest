import type { CSSProperties } from "react";

/** Fixed width of the hover panel (used for viewport-edge clamping too). */
export const PANEL_WIDTH = 380;

/** Max finding rows before a "+N more" footer caps the panel height. */
export const MAX_ROWS = 6;

/** Grace period before closing, so the pointer can cross the trigger→panel gap. */
export const CLOSE_DELAY_MS = 120;

export const s = {
  wrap: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
  } satisfies CSSProperties,
  chips: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
  } satisfies CSSProperties,
  // Opt-in focusable trigger (`triggerLabel`): a button reset so the chips look
  // unchanged. The focus ring comes from the global `:focus-visible` rule.
  trigger: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: 0,
    margin: 0,
    border: "none",
    background: "none",
    font: "inherit",
    color: "inherit",
    cursor: "pointer",
  } satisfies CSSProperties,
  // position:fixed so the panel escapes the PR-list table's `overflow:hidden`
  // clip; coordinates come from the trigger's bounding rect on hover.
  panel: (top: number, left: number): CSSProperties => ({
    position: "fixed",
    top,
    left,
    width: PANEL_WIDTH,
    maxHeight: 360,
    overflowY: "auto",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border-strong)",
    borderRadius: 10,
    boxShadow: "var(--shadow-modal)",
    padding: 10,
    zIndex: 50,
    animation: "ddpop .12s ease",
  }),
  heading: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--text-muted)",
    padding: "2px 4px 8px",
  } satisfies CSSProperties,
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  } satisfies CSSProperties,
  // `groupBySeverity` mode: one labelled block per severity.
  group: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    paddingTop: 6,
  } satisfies CSSProperties,
  groupHead: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "0 4px",
  } satisfies CSSProperties,
  // Only reachable if the API ever ships a severity the design system has no
  // token for — a readable label beats crashing the panel.
  groupFallback: {
    fontSize: 12,
    fontWeight: 600,
    textTransform: "uppercase",
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  row: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "8px 6px",
    borderTop: "1px solid var(--border)",
  } satisfies CSSProperties,
  rowHead: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    minWidth: 0,
  } satisfies CSSProperties,
  rowTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  rowMeta: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  } satisfies CSSProperties,
  rowFile: {
    fontSize: 12,
    color: "var(--text-secondary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  rowRationale: {
    fontSize: 12,
    lineHeight: 1.45,
    color: "var(--text-muted)",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  } as CSSProperties,
  muted: {
    fontSize: 12.5,
    color: "var(--text-muted)",
    padding: "4px 6px",
  } satisfies CSSProperties,
  more: {
    fontSize: 12,
    color: "var(--text-muted)",
    padding: "8px 6px 2px",
    borderTop: "1px solid var(--border)",
  } satisfies CSSProperties,
} as const;
