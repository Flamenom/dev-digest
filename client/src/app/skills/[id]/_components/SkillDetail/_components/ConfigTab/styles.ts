import type { CSSProperties } from "react";

/** Co-located styles for the skill ConfigTab. */
export const s = {
  wrap: { maxWidth: 760 } satisfies CSSProperties,
  header: { display: "flex", alignItems: "center", marginBottom: 20 } satisfies CSSProperties,
  h2: { fontSize: 18, fontWeight: 700 } satisfies CSSProperties,
  enabledLabel: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: 10,
    fontSize: 13,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  actions: { display: "flex", alignItems: "center", gap: 10, marginTop: 10 } satisfies CSSProperties,
  spacer: { flex: 1 } satisfies CSSProperties,
  noteBody: { padding: "20px 24px" } satisfies CSSProperties,
  noteFooter: { display: "flex", justifyContent: "flex-end", gap: 10 } satisfies CSSProperties,
} as const;
