import type { CSSProperties } from "react";

/** Co-located styles for a finding's publish checkbox / published state. */
export const s = {
  root: {
    display: "inline-flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "4px 10px",
    fontSize: 12.5,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  checkbox: { gap: 8, fontSize: 12.5 } satisfies CSSProperties,
  note: { color: "var(--text-muted)" } satisfies CSSProperties,
  reason: { color: "var(--text-muted)", fontStyle: "italic" } satisfies CSSProperties,
  published: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  publishedIcon: { color: "var(--accent)" } satisfies CSSProperties,
  link: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontWeight: 550,
    color: "var(--accent-text)",
    textDecoration: "none",
  } satisfies CSSProperties,
  /** Visually hidden, still in the accessibility tree (accessible name of the checkbox). */
  srOnly: {
    position: "absolute",
    width: 1,
    height: 1,
    margin: -1,
    padding: 0,
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    border: 0,
  } satisfies CSSProperties,
} as const;
