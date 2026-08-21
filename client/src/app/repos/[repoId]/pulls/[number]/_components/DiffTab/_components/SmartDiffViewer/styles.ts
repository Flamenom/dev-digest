import type { CSSProperties } from "react";

/** Co-located styles for the SmartDiffViewer (tokens only, no hardcoded hex). */
export const s = {
  wrap: { display: "flex", flexDirection: "column", gap: 18 } satisfies CSSProperties,
  statRow: {
    fontSize: 13,
    color: "var(--text-secondary)",
    display: "flex",
    alignItems: "center",
    gap: 8,
  } satisfies CSSProperties,
  empty: {
    padding: "24px",
    fontSize: 14,
    color: "var(--text-muted)",
    textAlign: "center",
  } satisfies CSSProperties,

  splitHint: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--warn-bg)",
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  } satisfies CSSProperties,
  splitTitle: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13.5,
    fontWeight: 600,
    color: "var(--text-primary)",
  } satisfies CSSProperties,
  splitBody: { fontSize: 12.5, color: "var(--text-secondary)" } satisfies CSSProperties,
  splitList: {
    margin: "4px 0 0",
    padding: 0,
    listStyle: "none",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  } satisfies CSSProperties,
  splitItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    fontSize: 12.5,
  } satisfies CSSProperties,
  splitName: { color: "var(--text-primary)" } satisfies CSSProperties,
  splitCount: { color: "var(--text-muted)", fontSize: 12 } satisfies CSSProperties,

  section: { display: "flex", flexDirection: "column", gap: 10 } satisfies CSSProperties,
  sectionHeader: {
    display: "flex",
    alignItems: "baseline",
    gap: 10,
    cursor: "pointer",
    userSelect: "none",
  } satisfies CSSProperties,
  sectionTitle: { fontSize: 13.5, fontWeight: 600, color: "var(--text-primary)" } satisfies CSSProperties,
  sectionSub: { fontSize: 12, color: "var(--text-muted)" } satisfies CSSProperties,
  sectionCount: {
    marginLeft: "auto",
    fontSize: 12,
    color: "var(--text-muted)",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  filesList: { display: "flex", flexDirection: "column", gap: 10 } satisfies CSSProperties,

  largeHint: {
    fontSize: 11.5,
    color: "var(--warn)",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
} as const;

/** The coloured role square in a section header. */
export function roleSquare(color: string): CSSProperties {
  return {
    width: 10,
    height: 10,
    borderRadius: 2,
    background: color,
    flexShrink: 0,
    alignSelf: "center",
  };
}

/** Section chevron rotates 90deg when the section is open. */
export function sectionChevron(open: boolean): CSSProperties {
  return {
    color: "var(--text-muted)",
    transform: open ? "rotate(90deg)" : "none",
    transition: "transform .12s",
    alignSelf: "center",
    flexShrink: 0,
  };
}
