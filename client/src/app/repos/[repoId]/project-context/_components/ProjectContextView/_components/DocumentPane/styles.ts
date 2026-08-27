import type { CSSProperties } from "react";

export const s = {
  pane: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
  } satisfies CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 16px",
    borderBottom: "1px solid var(--border)",
  } satisfies CSSProperties,
  title: {
    fontSize: 13.5,
    fontWeight: 600,
    color: "var(--text-primary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  tabs: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  } satisfies CSSProperties,
  usedBy: {
    marginLeft: "auto",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12.5,
    color: "var(--text-muted)",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  body: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: "16px 20px",
  } satisfies CSSProperties,
  editor: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    fontSize: 12.5,
    fontWeight: 600,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  warning: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    marginBottom: 12,
    padding: "8px 12px",
    borderRadius: 7,
    fontSize: 12.5,
    lineHeight: 1.5,
    color: "var(--warn)",
    background: "var(--warn-bg)",
  } satisfies CSSProperties,
  footerRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 20px",
    borderTop: "1px solid var(--border)",
  } satisfies CSSProperties,
  saveStatus: {
    fontSize: 12.5,
    minHeight: 18,
  } satisfies CSSProperties,
  saveSuccess: {
    color: "var(--ok)",
  } satisfies CSSProperties,
  saveFailure: {
    color: "var(--crit)",
  } satisfies CSSProperties,
  muted: {
    fontSize: 13,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
} as const;
