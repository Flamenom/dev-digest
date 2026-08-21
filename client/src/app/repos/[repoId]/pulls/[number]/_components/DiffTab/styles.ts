import type { CSSProperties } from "react";

/** Segmented Smart/Original order control — the vendored Button only honors
 *  `active` for kind="tertiary", so the toggle draws its own active state. */
export const styles = {
  segmented: {
    display: "inline-flex",
    alignItems: "center",
    gap: 2,
    padding: 2,
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--bg-surface)",
  } as CSSProperties,

  segment: (active: boolean): CSSProperties => ({
    padding: "4px 10px",
    fontSize: 12.5,
    fontWeight: 500,
    lineHeight: 1.2,
    letterSpacing: "-0.01em",
    borderRadius: 6,
    border: "1px solid transparent",
    cursor: active ? "default" : "pointer",
    background: active ? "var(--bg-elevated)" : "transparent",
    color: active ? "var(--text-primary)" : "var(--text-muted)",
    borderColor: active ? "var(--border-strong)" : "transparent",
    transition: "background .12s, border-color .12s, color .12s",
    whiteSpace: "nowrap",
  }),
};
