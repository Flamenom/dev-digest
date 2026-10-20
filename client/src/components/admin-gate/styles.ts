import type { CSSProperties } from "react";

/** Co-located styles for the admin gate primitives. */
export const s = {
  /** Visible "Admins only" explanation next to a gated control. */
  hint: {
    fontSize: 12,
    color: "var(--text-muted)",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  /** Block-level "Admins only" reason above a read-only list (AdminHint). */
  blockHint: {
    fontSize: 12,
    color: "var(--text-muted)",
    marginBottom: 8,
  } satisfies CSSProperties,
};
