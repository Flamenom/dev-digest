/* styles.ts — inline CSSProperties + CSS tokens (no Tailwind). */
import type { CSSProperties } from "react";
import { toneColor, type DeltaTone } from "../../helpers";

export const s = {
  row: {
    display: "flex",
    gap: 14,
    flexWrap: "wrap",
  } satisfies CSSProperties,
  card: {
    flex: "1 1 220px",
    minWidth: 220,
    display: "flex",
  } satisfies CSSProperties,
  value: {
    display: "inline-flex",
    alignItems: "baseline",
    gap: 10,
  } satisfies CSSProperties,
  delta: (tone: DeltaTone): CSSProperties => ({
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: 0,
    color: toneColor(tone),
  }),
};
