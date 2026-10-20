import type { CSSProperties } from "react";

/** Co-located styles for the persistent GitLab token notice. */
export const s = {
  box: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    padding: "10px 12px",
    border: "1px solid var(--warn)",
    borderRadius: 8,
    background: "var(--warn-bg)",
    color: "var(--text)",
    fontSize: 13,
    lineHeight: 1.45,
  } satisfies CSSProperties,
  icon: {
    flexShrink: 0,
    marginTop: 2,
    color: "var(--warn)",
  } satisfies CSSProperties,
  body: {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px 8px",
  } satisfies CSSProperties,
  action: {
    fontWeight: 550,
    color: "var(--accent-text)",
  } satisfies CSSProperties,
  muted: {
    color: "var(--text-muted)",
  } satisfies CSSProperties,
} as const;
