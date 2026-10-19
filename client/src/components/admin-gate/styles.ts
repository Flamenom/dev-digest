import type { CSSProperties } from "react";

/** Co-located styles for the admin gate primitives. */
export const s = {
  /** Visible "Admins only" explanation next to a gated control. */
  hint: {
    fontSize: 12,
    color: "var(--text-muted)",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  /** Visual "disabled" look for an aria-disabled (still focusable) control. */
  inertControl: {
    opacity: 0.6,
    cursor: "not-allowed",
  } satisfies CSSProperties,
};
