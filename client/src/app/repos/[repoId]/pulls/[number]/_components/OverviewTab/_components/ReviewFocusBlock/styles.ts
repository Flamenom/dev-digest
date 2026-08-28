import type { CSSProperties } from "react";

export const s = {
  // Count badge sits next to the SectionLabel text, not right-aligned — reset
  // the label's uppercase tracking so a bare number renders as a number.
  countBadge: {
    letterSpacing: 0,
    textTransform: "none",
  } satisfies CSSProperties,

  card: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-elevated)",
    padding: 18,
  } satisfies CSSProperties,

  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  } satisfies CSSProperties,

  item: {
    display: "flex",
  } satisfies CSSProperties,

  // Native <button>: Enter/Space activation and tab-reachability come from the
  // element, so the styling only has to undo the UA chrome (AC-30, NFR-5).
  itemBtn: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    width: "100%",
    padding: "3px 4px",
    border: "1px solid transparent",
    borderRadius: 6,
    background: "transparent",
    cursor: "pointer",
    textAlign: "left",
    font: "inherit",
    fontSize: 13,
    lineHeight: 1.5,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,

  itemIcon: {
    color: "var(--accent)",
    flexShrink: 0,
    alignSelf: "center",
  } satisfies CSSProperties,

  itemRef: {
    color: "var(--accent)",
    fontSize: 12.5,
    whiteSpace: "nowrap",
  } satisfies CSSProperties,

  // Model prose — rendered as a text node, never as markup (NFR-6).
  itemReason: {
    color: "var(--text-secondary)",
    minWidth: 0,
  } satisfies CSSProperties,

  empty: {
    margin: 0,
    fontSize: 13,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
} as const;
