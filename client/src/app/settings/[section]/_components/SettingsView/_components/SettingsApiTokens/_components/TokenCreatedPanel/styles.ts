import type { CSSProperties } from "react";

/** Co-located styles for the shown-once token panel. */
export const s = {
  panel: {
    margin: "4px 0 20px",
    padding: "14px 16px",
    borderRadius: 8,
    border: "1px solid var(--ok)",
    background: "var(--bg-surface)",
  } satisfies CSSProperties,
  title: { fontSize: 14, fontWeight: 700, marginBottom: 4 } satisfies CSSProperties,
  body: { fontSize: 13, color: "var(--text-secondary)", marginBottom: 12, lineHeight: 1.45 } satisfies CSSProperties,
  row: { display: "flex", gap: 10, alignItems: "center" } satisfies CSSProperties,
  value: { flex: 1, minWidth: 0 } satisfies CSSProperties,
} as const;
