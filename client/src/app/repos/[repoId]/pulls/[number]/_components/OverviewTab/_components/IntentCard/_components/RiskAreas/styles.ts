import type { CSSProperties } from "react";

export const s = {
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  } satisfies CSSProperties,

  row: {
    border: "1px solid var(--border)",
    borderRadius: 6,
    background: "var(--bg-surface)",
    overflow: "hidden",
  } satisfies CSSProperties,

  // Title + primary ref on the left, the chevron toggle pinned right.
  rowHead: {
    display: "flex",
    alignItems: "stretch",
  } satisfies CSSProperties,

  rowMain: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    padding: "8px 10px",
  } satisfies CSSProperties,

  severityIcon: (color: string): CSSProperties => ({
    flexShrink: 0,
    marginTop: 2,
    color,
  }),

  rowText: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 2,
  } satisfies CSSProperties,

  title: {
    fontSize: 13,
    fontWeight: 600,
    lineHeight: 1.4,
    color: "var(--text-primary)",
  } satisfies CSSProperties,

  // Long unbreakable paths scroll inside the row instead of spilling out.
  refLine: {
    display: "flex",
    alignItems: "baseline",
    gap: 6,
    minWidth: 0,
    overflowX: "auto",
  } satisfies CSSProperties,

  moreRefs: {
    flexShrink: 0,
    fontSize: 11.5,
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  toggle: {
    flexShrink: 0,
    width: 32,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    border: "none",
    borderLeft: "1px solid var(--border)",
    background: "transparent",
    color: "var(--text-muted)",
    cursor: "pointer",
  } satisfies CSSProperties,

  chevron: (open: boolean): CSSProperties => ({
    flexShrink: 0,
    transform: open ? "rotate(180deg)" : "none",
    transition: "transform .12s",
  }),

  body: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "8px 10px 10px 31px",
    borderTop: "1px solid var(--border)",
  } satisfies CSSProperties,

  explanation: {
    margin: 0,
    fontSize: 12.5,
    lineHeight: 1.5,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,

  refList: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 3,
    overflowX: "auto",
  } satisfies CSSProperties,

  refBtn: {
    display: "inline-flex",
    alignItems: "baseline",
    padding: "1px 2px",
    border: "none",
    background: "transparent",
    cursor: "pointer",
    fontSize: 12.5,
    color: "var(--accent)",
    textAlign: "left",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
} as const;
