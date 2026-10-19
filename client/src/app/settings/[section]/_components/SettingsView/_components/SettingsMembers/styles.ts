import type { CSSProperties } from "react";

/** Co-located styles for SettingsMembers (table shell + banner). */
export const s = {
  wrap: { maxWidth: 960 } satisfies CSSProperties,
  banner: {
    display: "flex",
    gap: 10,
    alignItems: "center",
    marginBottom: 16,
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid var(--warn)",
    background: "var(--warn-bg)",
    color: "var(--text-primary)",
    fontSize: 13,
    fontWeight: 600,
  } satisfies CSSProperties,
  bannerIcon: { color: "var(--warn)", flexShrink: 0 } satisfies CSSProperties,
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 } satisfies CSSProperties,
  th: {
    textAlign: "left",
    padding: "8px 10px",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-muted)",
    borderBottom: "1px solid var(--border)",
  } satisfies CSSProperties,
  muted: { fontSize: 13, color: "var(--text-muted)" } satisfies CSSProperties,
  error: { fontSize: 13, color: "var(--crit)" } satisfies CSSProperties,
} as const;
