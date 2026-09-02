/* styles.ts — inline CSSProperties + CSS tokens (no Tailwind). */
import type { CSSProperties } from "react";

export const s = {
  group: {
    display: "inline-flex",
    alignItems: "center",
    gap: 2,
    padding: 2,
    borderRadius: 8,
    border: "1px solid var(--border-strong)",
    background: "var(--bg-elevated)",
  } satisfies CSSProperties,

  option: (active: boolean): CSSProperties => ({
    padding: "5px 11px",
    fontSize: 12.5,
    fontWeight: 600,
    borderRadius: 6,
    border: "1px solid transparent",
    cursor: "pointer",
    whiteSpace: "nowrap",
    background: active ? "var(--accent-bg)" : "transparent",
    color: active ? "var(--accent-text)" : "var(--text-secondary)",
  }),
};
