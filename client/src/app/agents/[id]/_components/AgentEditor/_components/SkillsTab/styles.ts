import type { CSSProperties } from "react";

/** Co-located styles for SkillsTab. */
export const s = {
  wrap: { maxWidth: 760 } satisfies CSSProperties,
  header: { display: "flex", alignItems: "center", gap: 12, marginBottom: 8 } satisfies CSSProperties,
  h2: { fontSize: 18, fontWeight: 700 } satisfies CSSProperties,
  filterBox: { marginLeft: "auto", width: 220 } satisfies CSSProperties,
  caption: { fontSize: 13, color: "var(--text-muted)", marginBottom: 16, lineHeight: 1.5 } satisfies CSSProperties,
  list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 } satisfies CSSProperties,
  row: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--bg-surface)",
  } satisfies CSSProperties,
  rowDragging: { opacity: 0.5, border: "1px dashed var(--accent)" } satisfies CSSProperties,
  rowMuted: { opacity: 0.55 } satisfies CSSProperties,
  handle: {
    cursor: "grab",
    color: "var(--text-muted)",
    fontSize: 15,
    lineHeight: 1,
    userSelect: "none",
    width: 16,
    textAlign: "center",
  } satisfies CSSProperties,
  handlePlaceholder: { width: 16 } satisfies CSSProperties,
  name: { fontSize: 13.5, color: "var(--text-primary)", flex: 1, minWidth: 0 } satisfies CSSProperties,
  badges: { display: "flex", alignItems: "center", gap: 8 } satisfies CSSProperties,
  noMatches: { fontSize: 13, color: "var(--text-muted)", padding: "20px 4px" } satisfies CSSProperties,
  skeletons: { display: "flex", flexDirection: "column", gap: 8 } satisfies CSSProperties,
} as const;
