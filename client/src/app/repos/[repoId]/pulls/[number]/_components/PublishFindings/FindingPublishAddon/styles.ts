import type { CSSProperties } from "react";

/** Co-located styles for the publish control's slot in a FindingCard header. */
export const s = {
  root: { flexShrink: 0, display: "flex", alignItems: "center" } satisfies CSSProperties,
} as const;
