import type { CSSProperties } from "react";

/** Co-located styles for SettingsApiTokens (shell + token table). */
export const s = {
  wrap: { maxWidth: 900 } satisfies CSSProperties,
  listTitle: { fontSize: 15, fontWeight: 700, margin: "28px 0 10px" } satisfies CSSProperties,
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 } satisfies CSSProperties,
  th: {
    textAlign: "left",
    padding: "8px 10px",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-muted)",
    borderBottom: "1px solid var(--border)",
  } satisfies CSSProperties,
  muted: { fontSize: 13, color: "var(--text-muted)" } satisfies CSSProperties,
  error: { fontSize: 13, color: "var(--crit)" } satisfies CSSProperties,
} as const;
