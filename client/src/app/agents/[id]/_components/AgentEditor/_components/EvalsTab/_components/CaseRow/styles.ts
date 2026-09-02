import type { CSSProperties } from "react";

/** Co-located styles for one eval-case row of the AgentEditor Evals tab. */
export const s = {
  row: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--bg-surface)",
  } satisfies CSSProperties,
  statusSlot: { width: 18, display: "inline-flex", justifyContent: "center" } satisfies CSSProperties,
  nameBox: { display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 } satisfies CSSProperties,
  name: {
    fontSize: 13.5,
    color: "var(--text-primary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  sub: {
    fontSize: 12,
    color: "var(--text-muted)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  actions: { display: "flex", alignItems: "center", gap: 2 } satisfies CSSProperties,
} as const;
