import type { CSSProperties } from "react";

export const s = {
  // All-longhand borders per side (`borderColor`/`borderWidth` are shorthands
  // too — React warns when a shorthand and a longhand like `borderLeftColor`
  // update on the same rerender).
  card: (accepted: boolean, rejected: boolean): CSSProperties => ({
    display: "flex",
    alignItems: "flex-start",
    gap: 16,
    padding: "16px 18px",
    borderRadius: 10,
    borderStyle: "solid",
    borderTopWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderTopColor: "var(--border)",
    borderRightColor: "var(--border)",
    borderBottomColor: "var(--border)",
    borderLeftWidth: 3,
    borderLeftColor: accepted ? "var(--ok)" : rejected ? "var(--failed)" : "var(--border-strong)",
    background: "var(--bg-elevated)",
    opacity: rejected ? 0.6 : 1,
    transition: "opacity .2s, border-color .12s",
  }),
  main: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  } satisfies CSSProperties,
  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minWidth: 0,
  } satisfies CSSProperties,
  title: (rejected: boolean): CSSProperties => ({
    fontSize: 15,
    fontWeight: 650,
    fontStyle: "italic",
    color: "var(--text-primary)",
    textDecoration: rejected ? "line-through" : "none",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  }),
  editRow: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    gap: 8,
    minWidth: 0,
  } satisfies CSSProperties,
  confidenceRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  } satisfies CSSProperties,
  confidenceLabel: {
    fontSize: 12,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  confidenceBar: {
    width: 120,
  } satisfies CSSProperties,
  confidencePct: {
    fontSize: 12,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  actions: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    flexShrink: 0,
    minWidth: 132,
  } satisfies CSSProperties,
} as const;
