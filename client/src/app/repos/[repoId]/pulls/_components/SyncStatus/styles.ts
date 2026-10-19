import type { CSSProperties } from "react";

/** Co-located styles for the PR-list sync status. */
export const s = {
  wrap: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 4,
  } satisfies CSSProperties,
  line: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  updating: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    color: "var(--accent-text)",
    fontWeight: 550,
  } satisfies CSSProperties,
  notice: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    color: "var(--warn)",
  } satisfies CSSProperties,
} as const;
