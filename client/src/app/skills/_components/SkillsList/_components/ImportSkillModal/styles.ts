import type { CSSProperties } from "react";

/** Co-located styles for ImportSkillModal. */
export const s = {
  body: { padding: "20px 24px" } satisfies CSSProperties,
  fileInput: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 7,
    border: "1px dashed var(--border-strong)",
    background: "var(--bg-elevated)",
    color: "var(--text-secondary)",
    fontSize: 13,
  } satisfies CSSProperties,
  error: { fontSize: 13, color: "var(--crit)", marginTop: 4 } satisfies CSSProperties,
  bodyCard: { maxHeight: 240, overflow: "auto", fontSize: 13 } satisfies CSSProperties,
  listBlock: {
    border: "1px solid var(--border)",
    borderRadius: 7,
    padding: "10px 12px",
    marginBottom: 14,
    background: "var(--bg-surface)",
  } satisfies CSSProperties,
  listTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--warn)",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    marginBottom: 6,
  } satisfies CSSProperties,
  list: { margin: 0, paddingLeft: 18 } satisfies CSSProperties,
  listItem: { fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.6 } satisfies CSSProperties,
  notice: {
    fontSize: 12.5,
    color: "var(--text-muted)",
    lineHeight: 1.5,
    padding: "8px 10px",
    borderRadius: 6,
    background: "var(--bg-hover)",
  } satisfies CSSProperties,
  footer: { display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end" } satisfies CSSProperties,
} as const;
