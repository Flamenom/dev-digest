/* styles.ts — inline CSSProperties + CSS tokens (no Tailwind). */
import type { CSSProperties } from "react";

export const s = {
  section: {
    background: "var(--bg-surface)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "16px 18px",
  } satisfies CSSProperties,
  actions: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  } satisfies CSSProperties,
  hint: {
    fontSize: 12,
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 13,
  } satisfies CSSProperties,
  th: {
    textAlign: "left",
    padding: "8px 10px",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--text-muted)",
    borderBottom: "1px solid var(--border)",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  thNum: {
    textAlign: "right",
    padding: "8px 10px",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--text-muted)",
    borderBottom: "1px solid var(--border)",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  td: {
    padding: "9px 10px",
    borderBottom: "1px solid var(--border)",
    color: "var(--text-secondary)",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  tdNum: {
    padding: "9px 10px",
    borderBottom: "1px solid var(--border)",
    color: "var(--text-primary)",
    textAlign: "right",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  tdCheck: {
    padding: "9px 4px 9px 10px",
    borderBottom: "1px solid var(--border)",
    width: 34,
  } satisfies CSSProperties,
  running: {
    padding: "9px 10px",
    borderBottom: "1px solid var(--border)",
    color: "var(--pending)",
    fontWeight: 600,
  } satisfies CSSProperties,
  version: {
    color: "var(--text-muted)",
    marginLeft: 8,
  } satisfies CSSProperties,
};
