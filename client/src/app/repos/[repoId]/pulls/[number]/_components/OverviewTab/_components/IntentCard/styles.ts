import type { CSSProperties } from "react";

export const s = {
  card: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-elevated)",
    padding: 18,
    display: "flex",
    flexDirection: "column",
    gap: 16,
  } satisfies CSSProperties,

  badgeRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  } satisfies CSSProperties,

  summary: {
    margin: 0,
    fontStyle: "italic",
    fontSize: 14,
    lineHeight: 1.55,
    color: "var(--text-primary)",
    borderLeft: "3px solid var(--border)",
    paddingLeft: 14,
  } satisfies CSSProperties,

  columns: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 20,
  } satisfies CSSProperties,

  columnTitle: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.07em",
    textTransform: "uppercase",
    color: "var(--text-muted)",
    marginBottom: 8,
  } satisfies CSSProperties,

  scopeList: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  } satisfies CSSProperties,

  scopeItem: (dimmed: boolean): CSSProperties => ({
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    fontSize: 13,
    lineHeight: 1.5,
    color: dimmed ? "var(--text-muted)" : "var(--text-secondary)",
    opacity: dimmed ? 0.75 : 1,
  }),

  scopeIcon: (dimmed: boolean): CSSProperties => ({
    flexShrink: 0,
    marginTop: 3,
    color: dimmed ? "var(--text-muted)" : "var(--ok)",
  }),

  missingContextBadge: {
    maxWidth: 320,
  } satisfies CSSProperties,

  riskRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  } satisfies CSSProperties,

  empty: {
    border: "1px dashed var(--border)",
    borderRadius: 8,
    background: "var(--bg-elevated)",
    padding: 24,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 10,
  } satisfies CSSProperties,

  emptyText: {
    margin: 0,
    fontSize: 13,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,

  emptyHint: {
    margin: 0,
    fontSize: 12,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
} as const;
