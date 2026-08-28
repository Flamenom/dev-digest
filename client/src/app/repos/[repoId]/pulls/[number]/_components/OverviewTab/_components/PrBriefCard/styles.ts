import type { CSSProperties } from "react";

/** Co-located styles — CSS tokens only, never Tailwind utility classes. */
export const s = {
  card: {
    display: "flex",
    gap: 18,
    alignItems: "flex-start",
    padding: 18,
    borderRadius: 10,
    border: "1px solid var(--border)",
    background: "var(--bg-elevated)",
  } satisfies CSSProperties,

  iconBox: (bg: string, color: string): CSSProperties => ({
    width: 40,
    height: 40,
    borderRadius: 9,
    display: "grid",
    placeItems: "center",
    background: bg,
    color,
    flexShrink: 0,
  }),

  main: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  } satisfies CSSProperties,

  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
  } satisfies CSSProperties,

  label: (color: string): CSSProperties => ({ fontSize: 18, fontWeight: 700, color }),

  cta: {
    fontSize: 13,
    fontWeight: 500,
    color: "var(--accent-text, var(--accent))",
  } satisfies CSSProperties,

  prose: {
    margin: 0,
    fontSize: 14,
    lineHeight: 1.55,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,

  proseWhy: {
    margin: 0,
    fontSize: 13.5,
    lineHeight: 1.55,
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  note: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px dashed var(--border)",
  } satisfies CSSProperties,

  noteTitle: {
    margin: 0,
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,

  noteReason: {
    margin: 0,
    fontSize: 12.5,
    lineHeight: 1.5,
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  staleReason: {
    margin: 0,
    fontSize: 12.5,
    lineHeight: 1.5,
    color: "var(--warn)",
  } satisfies CSSProperties,

  missing: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  } satisfies CSSProperties,

  missingTitle: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.07em",
    textTransform: "uppercase",
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  missingList: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 4,
  } satisfies CSSProperties,

  missingItem: {
    fontSize: 12.5,
    lineHeight: 1.5,
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  missingInput: {
    color: "var(--text-secondary)",
    fontWeight: 600,
  } satisfies CSSProperties,

  rightCol: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 8,
    flexShrink: 0,
  } satisfies CSSProperties,

  scoreCol: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
  } satisfies CSSProperties,

  scoreLabel: {
    fontSize: 12,
    color: "var(--text-muted)",
    letterSpacing: "0.04em",
  } satisfies CSSProperties,

  riskLevel: (color: string): CSSProperties => ({
    fontSize: 11.5,
    fontWeight: 600,
    letterSpacing: "0.02em",
    color,
  }),

  costRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12,
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  costIcon: { color: "var(--text-muted)", flexShrink: 0 } satisfies CSSProperties,

  tokens: { fontSize: 12, color: "var(--text-muted)" } satisfies CSSProperties,

  empty: {
    border: "1px dashed var(--border)",
    borderRadius: 10,
    background: "var(--bg-elevated)",
    padding: 24,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 8,
  } satisfies CSSProperties,

  emptyText: { margin: 0, fontSize: 13, color: "var(--text-secondary)" } satisfies CSSProperties,

  emptyHint: { margin: 0, fontSize: 12, color: "var(--text-muted)" } satisfies CSSProperties,
} as const;
