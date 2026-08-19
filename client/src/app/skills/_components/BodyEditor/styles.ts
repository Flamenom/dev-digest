import type { CSSProperties } from "react";

export const LINE_HEIGHT = 20;

/** Co-located styles for BodyEditor. Gutter and textarea share font metrics
    so line numbers stay aligned with the text. */
export const s = {
  frame: {
    border: "1px solid var(--border-strong)",
    borderRadius: 7,
    background: "var(--bg-elevated)",
    overflow: "hidden",
  } satisfies CSSProperties,
  chrome: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    borderBottom: "1px solid var(--border)",
    background: "var(--bg-surface)",
  } satisfies CSSProperties,
  filename: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-secondary)",
    padding: "2px 8px",
    borderRadius: 5,
    background: "var(--bg-hover)",
  } satisfies CSSProperties,
  unsaved: {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--warn)",
    background: "var(--warn-bg)",
    padding: "2px 8px",
    borderRadius: 5,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  } satisfies CSSProperties,
  tokens: {
    marginLeft: "auto",
    fontSize: 12,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  scroller: {
    display: "flex",
    alignItems: "stretch",
    maxHeight: 420,
    overflow: "auto",
  } satisfies CSSProperties,
  gutter: {
    flexShrink: 0,
    padding: "10px 0",
    minWidth: 42,
    textAlign: "right",
    fontSize: 12,
    lineHeight: `${LINE_HEIGHT}px`,
    color: "var(--text-muted)",
    background: "var(--bg-surface)",
    borderRight: "1px solid var(--border)",
    userSelect: "none",
    height: "100%",
  } satisfies CSSProperties,
  // Height = the measured height of the SAME logical line in the mirror, so a
  // wrapped line keeps one number and the following numbers stay aligned.
  gutterLine: (height: number): CSSProperties => ({ padding: "0 10px", height }),
  textWrap: {
    position: "relative",
    flex: 1,
    minWidth: 0,
    display: "flex",
  } satisfies CSSProperties,
  // Invisible copy of the textarea's text, one block per logical line, with
  // identical width/font/wrapping — the gutter measures line heights from it.
  mirror: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    visibility: "hidden",
    pointerEvents: "none",
    padding: "0 12px",
    fontSize: 13,
    lineHeight: `${LINE_HEIGHT}px`,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  } satisfies CSSProperties,
  textarea: {
    flex: 1,
    minWidth: 0,
    resize: "none",
    overflow: "hidden",
    padding: "10px 12px",
    border: "none",
    outline: "none",
    background: "transparent",
    color: "var(--text-primary)",
    fontSize: 13,
    lineHeight: `${LINE_HEIGHT}px`,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  } satisfies CSSProperties,
} as const;
