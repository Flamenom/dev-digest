import type { CSSProperties } from "react";

/** Co-located styles for the skill VersionsTab + diff modal. */
export const s = {
  wrap: { maxWidth: 760 } satisfies CSSProperties,
  caption: { fontSize: 13, color: "var(--text-secondary)", marginBottom: 14 } satisfies CSSProperties,
  row: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "12px 16px",
    borderBottom: "1px solid var(--border)",
  } satisfies CSSProperties,
  note: {
    fontSize: 13.5,
    flex: 1,
    minWidth: 0,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  } satisfies CSSProperties,
  date: { fontSize: 12, color: "var(--text-muted)", flexShrink: 0 } satisfies CSSProperties,
  empty: { fontSize: 13, color: "var(--text-muted)", padding: 16 } satisfies CSSProperties,
  diffBody: { padding: "14px 0", overflow: "auto" } satisfies CSSProperties,
  diffEmpty: { fontSize: 13, color: "var(--text-muted)", padding: "4px 20px" } satisfies CSSProperties,
  diffLine: (kind: "same" | "added" | "removed"): CSSProperties => ({
    display: "flex",
    gap: 10,
    padding: "1px 20px",
    fontSize: 12.5,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    background:
      kind === "added" ? "var(--code-add)" : kind === "removed" ? "var(--code-del)" : "transparent",
    color:
      kind === "added"
        ? "var(--code-add-text)"
        : kind === "removed"
          ? "var(--code-del-text)"
          : "var(--text-secondary)",
  }),
  diffSign: { width: 12, flexShrink: 0, userSelect: "none" } satisfies CSSProperties,
} as const;
