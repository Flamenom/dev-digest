import type { CSSProperties } from "react";

/** Co-located styles for NewSkillForm. */
export const s = {
  wrap: { maxWidth: 760, padding: 28 } satisfies CSSProperties,
  header: { display: "flex", alignItems: "center", gap: 10, marginBottom: 20 } satisfies CSSProperties,
  h1: { fontSize: 18, fontWeight: 700 } satisfies CSSProperties,
  actions: { display: "flex", gap: 10, marginTop: 10 } satisfies CSSProperties,
} as const;
