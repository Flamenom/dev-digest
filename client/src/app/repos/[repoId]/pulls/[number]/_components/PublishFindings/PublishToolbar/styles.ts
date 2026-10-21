import type { CSSProperties } from "react";
import { INERT_STYLE } from "@devdigest/ui";

/** Co-located styles for the publish toolbar (select-all + publish button). */
export const s = {
  bar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
    padding: "8px 0",
  } satisfies CSSProperties,
  selectAll: (inert: boolean): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: 0,
    border: "none",
    background: "transparent",
    color: "var(--text-secondary)",
    fontSize: 13,
    cursor: inert ? "not-allowed" : "pointer",
    ...(inert ? INERT_STYLE : {}),
  }),
  box: (state: "none" | "some" | "all"): CSSProperties => ({
    width: 16,
    height: 16,
    borderRadius: 4,
    border: "1.5px solid " + (state === "none" ? "var(--border-strong)" : "var(--accent)"),
    background: state === "none" ? "transparent" : "var(--accent)",
    display: "grid",
    placeItems: "center",
    color: "#fff",
    flexShrink: 0,
  }),
  dash: { width: 8, height: 2, borderRadius: 1, background: "#fff" } satisfies CSSProperties,
  inert: INERT_STYLE,
} as const;
