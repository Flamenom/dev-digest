import type { CSSProperties } from "react";

/** Co-located styles for the create-token form. */
export const s = {
  form: { display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" } satisfies CSSProperties,
  name: { flex: "1 1 260px" } satisfies CSSProperties,
  days: { width: 160 } satisfies CSSProperties,
  submit: { marginBottom: 20 } satisfies CSSProperties,
  error: { marginTop: -8, marginBottom: 12, fontSize: 13, color: "var(--crit)" } satisfies CSSProperties,
} as const;
