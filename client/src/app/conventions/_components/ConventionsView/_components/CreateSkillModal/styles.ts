import type { CSSProperties } from "react";

export const s = {
  body: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
    padding: "0 24px",
  } satisfies CSSProperties,
  banner: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 14px",
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    borderColor: "var(--border)",
    background: "var(--accent-bg)",
    color: "var(--text-secondary)",
    fontSize: 13,
  } satisfies CSSProperties,
  split: {
    display: "flex",
    gap: 24,
    alignItems: "flex-start",
  } satisfies CSSProperties,
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
  } satisfies CSSProperties,
  error: {
    fontSize: 13,
    color: "var(--crit)",
  } satisfies CSSProperties,
} as const;
