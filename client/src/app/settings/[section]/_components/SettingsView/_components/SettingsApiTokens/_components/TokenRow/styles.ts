import type { CSSProperties } from "react";

/** Co-located styles for one token-table row. */
export const s = {
  td: {
    padding: "10px",
    borderBottom: "1px solid var(--border)",
    verticalAlign: "middle",
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  name: { fontWeight: 600, color: "var(--text-primary)" } satisfies CSSProperties,
  error: { marginTop: 6, fontSize: 12, color: "var(--crit)" } satisfies CSSProperties,
} as const;
