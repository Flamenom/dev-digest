import type { CSSProperties } from "react";

export const s = {
  card: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-elevated)",
    padding: 18,
    display: "flex",
    flexDirection: "column",
    gap: 14,
  } satisfies CSSProperties,

  // Header counts row (symbols / callers / endpoints / cron).
  statRow: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    flexWrap: "wrap",
    fontSize: 12,
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  statValue: {
    fontWeight: 700,
    color: "var(--text-primary)",
    marginRight: 4,
  } satisfies CSSProperties,

  // Segmented Tree|Graph toggle — same pattern as DiffTab's order control.
  segmented: {
    display: "inline-flex",
    alignItems: "center",
    gap: 2,
    padding: 2,
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--bg-surface)",
  } satisfies CSSProperties,

  segment: (active: boolean): CSSProperties => ({
    padding: "3px 9px",
    fontSize: 12,
    fontWeight: 500,
    lineHeight: 1.2,
    borderRadius: 6,
    border: "1px solid transparent",
    cursor: active ? "default" : "pointer",
    background: active ? "var(--bg-elevated)" : "transparent",
    color: active ? "var(--text-primary)" : "var(--text-muted)",
    borderColor: active ? "var(--border-strong)" : "transparent",
    transition: "background .12s, border-color .12s, color .12s",
    whiteSpace: "nowrap",
  }),

  banner: (kind: "partial" | "degraded"): CSSProperties => ({
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    padding: "8px 10px",
    borderRadius: 6,
    fontSize: 12,
    lineHeight: 1.45,
    border: "1px solid var(--border)",
    background: "var(--bg-hover)",
    color: kind === "degraded" ? "var(--text-secondary)" : "var(--text-muted)",
  }),

  bannerHint: {
    marginTop: 2,
    fontSize: 11.5,
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  // --- Tree view -----------------------------------------------------------
  tree: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
  } satisfies CSSProperties,

  symbolRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 4px",
    borderRadius: 6,
    cursor: "pointer",
    userSelect: "none",
  } satisfies CSSProperties,

  symbolChevron: (open: boolean): CSSProperties => ({
    flexShrink: 0,
    color: "var(--text-muted)",
    transform: open ? "rotate(90deg)" : "none",
    transition: "transform .12s",
  }),

  symbolName: {
    fontSize: 13,
    color: "var(--text-primary)",
  } satisfies CSSProperties,

  symbolMeta: {
    marginLeft: "auto",
    fontSize: 11.5,
    color: "var(--text-muted)",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,

  symbolBody: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "2px 4px 8px 24px",
  } satisfies CSSProperties,

  // Long unbreakable file paths scroll inside the list instead of spilling
  // past the card edge.
  callerList: {
    listStyle: "none",
    margin: 0,
    padding: "0 0 2px 0",
    display: "flex",
    flexDirection: "column",
    gap: 3,
    overflowX: "auto",
  } satisfies CSSProperties,

  callerBtn: {
    display: "inline-flex",
    alignItems: "baseline",
    gap: 6,
    padding: "1px 2px",
    border: "none",
    background: "transparent",
    cursor: "pointer",
    fontSize: 12.5,
    color: "var(--accent)",
    textAlign: "left",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,

  callerVia: {
    fontSize: 11.5,
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  chipRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  } satisfies CSSProperties,

  noCallers: {
    fontSize: 12,
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  // Collapsed summary row for zero-caller symbols (no impact info to show).
  silentHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 4px",
    borderRadius: 6,
    cursor: "pointer",
    userSelect: "none",
    fontSize: 12,
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  silentList: {
    listStyle: "none",
    margin: 0,
    padding: "2px 4px 6px 24px",
    display: "flex",
    flexDirection: "column",
    gap: 3,
  } satisfies CSSProperties,

  silentItem: {
    fontSize: 12.5,
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  indirectRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
    paddingTop: 8,
    borderTop: "1px solid var(--border)",
    fontSize: 11.5,
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  // --- Prior PRs footer ------------------------------------------------------
  priorHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    paddingTop: 10,
    borderTop: "1px solid var(--border)",
    cursor: "pointer",
    userSelect: "none",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,

  priorList: {
    listStyle: "none",
    margin: 0,
    padding: "8px 0 0 0",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  } satisfies CSSProperties,

  priorItem: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    fontSize: 12.5,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,

  priorNumber: {
    color: "var(--accent)",
    textDecoration: "none",
    flexShrink: 0,
  } satisfies CSSProperties,

  priorTitle: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,

  priorMeta: {
    marginLeft: "auto",
    fontSize: 11.5,
    color: "var(--text-muted)",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,

  // --- Empty / silent states -------------------------------------------------
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
