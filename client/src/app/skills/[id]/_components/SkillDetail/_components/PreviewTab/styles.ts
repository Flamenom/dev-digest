import type { CSSProperties } from "react";

/** Co-located styles for the skill PreviewTab. */
export const s = {
  wrap: { maxWidth: 760 } satisfies CSSProperties,
  subtitle: { fontSize: 13, color: "var(--text-secondary)", marginBottom: 14 } satisfies CSSProperties,
  card: { fontSize: 13.5 } satisfies CSSProperties,
} as const;
