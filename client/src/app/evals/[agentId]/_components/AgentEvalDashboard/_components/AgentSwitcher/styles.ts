/* styles.ts — inline CSSProperties + CSS tokens (no Tailwind). */
import type { CSSProperties } from "react";

export const s = {
  wrap: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minWidth: 0,
  } satisfies CSSProperties,
  /** Visually hidden but announced — the control is icon/context-only by design. */
  srOnly: {
    position: "absolute",
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
    border: 0,
  } satisfies CSSProperties,
  select: {
    minWidth: 210,
  } satisfies CSSProperties,
};
