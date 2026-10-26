import type { CSSProperties } from "react";

const box = (border: string, bg: string): CSSProperties => ({
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "10px 12px",
  border: `1px solid ${border}`,
  borderRadius: 8,
  background: bg,
  color: "var(--text)",
  fontSize: 13,
  lineHeight: 1.45,
});

/** Co-located styles for the publish progress / result view. */
export const s = {
  progress: box("var(--border)", "var(--bg-surface)"),
  success: box("var(--accent)", "var(--bg-surface)"),
  failure: box("var(--crit)", "var(--crit-bg)"),
  stack: { display: "flex", flexDirection: "column", gap: 8 } satisfies CSSProperties,
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 10px" } satisfies CSSProperties,
  list: { margin: 0, paddingLeft: 18 } satisfies CSSProperties,
  link: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontWeight: 550,
    color: "var(--accent-text)",
    textDecoration: "none",
  } satisfies CSSProperties,
} as const;
