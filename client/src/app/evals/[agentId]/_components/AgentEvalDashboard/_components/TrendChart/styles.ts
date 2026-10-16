/* styles.ts — inline CSSProperties + CSS tokens (no Tailwind). */
import type { CSSProperties } from "react";

export const s = {
  section: {
    background: "var(--bg-surface)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "16px 18px",
  } satisfies CSSProperties,
  legend: {
    display: "flex",
    alignItems: "center",
    gap: 14,
  } satisfies CSSProperties,
  legendItem: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  swatch: (color: string): CSSProperties => ({
    width: 9,
    height: 9,
    borderRadius: 999,
    background: color,
    display: "inline-block",
  }),

  /* ---- single-point trend: a visible marker, not an empty chart (AC-28) ---- */
  singlePoint: {
    display: "flex",
    alignItems: "center",
    gap: 22,
    flexWrap: "wrap",
    padding: "26px 8px",
  } satisfies CSSProperties,
  marker: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    fontSize: 14,
    color: "var(--text-primary)",
  } satisfies CSSProperties,
  dot: (color: string): CSSProperties => ({
    width: 12,
    height: 12,
    borderRadius: 999,
    background: color,
    border: "2px solid var(--bg-surface)",
    boxShadow: `0 0 0 2px ${color}`,
    display: "inline-block",
  }),
};
