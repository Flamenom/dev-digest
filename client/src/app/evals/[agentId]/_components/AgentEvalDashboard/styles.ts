/* styles.ts — inline CSSProperties + CSS tokens (client/CLAUDE.md: no Tailwind
   utility classes anywhere in this app). */
import type { CSSProperties } from "react";

export const s = {
  page: {
    display: "flex",
    flexDirection: "column",
    gap: 22,
    padding: "22px 28px 40px",
  } satisfies CSSProperties,

  header: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
  } satisfies CSSProperties,
  titleBlock: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    minWidth: 0,
  } satisfies CSSProperties,
  title: {
    fontSize: 20,
    fontWeight: 700,
    letterSpacing: "-0.01em",
    color: "var(--text-primary)",
  } satisfies CSSProperties,
  subtitle: {
    fontSize: 13,
    color: "var(--text-secondary)",
    maxWidth: 620,
    lineHeight: 1.5,
  } satisfies CSSProperties,
  headerActions: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  } satisfies CSSProperties,

  cardsRow: {
    display: "flex",
    gap: 14,
    flexWrap: "wrap",
  } satisfies CSSProperties,

  section: {
    background: "var(--bg-surface)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "16px 18px",
  } satisfies CSSProperties,

  skeletons: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
    padding: "22px 28px",
  } satisfies CSSProperties,
};
