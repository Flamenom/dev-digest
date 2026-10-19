import type { CSSProperties } from "react";

/** FileCard-local styles; the shared diff styles live in `../styles`. */
export const fc = {
  /** Comment count chip in the file header. */
  commentCount: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: 12,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
} as const;
