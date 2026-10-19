import type { CSSProperties } from "react";

/** Co-located styles for one Members-table row. */
export const s = {
  td: {
    padding: "10px",
    borderBottom: "1px solid var(--border)",
    verticalAlign: "middle",
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  who: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 } satisfies CSSProperties,
  whoText: { minWidth: 0 } satisfies CSSProperties,
  name: { fontWeight: 600, color: "var(--text-primary)" } satisfies CSSProperties,
  you: { marginLeft: 6, fontSize: 12, fontWeight: 500, color: "var(--text-muted)" } satisfies CSSProperties,
  email: { fontSize: 12, color: "var(--text-muted)" } satisfies CSSProperties,
  status: (active: boolean): CSSProperties => ({
    fontSize: 12,
    fontWeight: 600,
    color: active ? "var(--ok)" : "var(--text-muted)",
  }),
  roleSelect: { display: "block", width: 130 } satisfies CSSProperties,
  srOnly: {
    position: "absolute",
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
    border: 0,
  } satisfies CSSProperties,
  error: { marginTop: 6, fontSize: 12, color: "var(--crit)" } satisfies CSSProperties,
} as const;
