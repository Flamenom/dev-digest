import type { CSSProperties } from "react";

/** Co-located styles for the skill StatsTab (minimal-honest, spec decision 8). */
export const s = {
  wrap: { maxWidth: 860 } satisfies CSSProperties,
  statRow: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 12,
    marginBottom: 20,
  } satisfies CSSProperties,
  statLabel: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--text-muted)",
    marginBottom: 6,
  } satisfies CSSProperties,
  statValue: { fontSize: 20, fontWeight: 700, color: "var(--text-primary)" } satisfies CSSProperties,
  placeholderCard: { opacity: 0.55 } satisfies CSSProperties,
  placeholderValue: { fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.4 } satisfies CSSProperties,
  panelTitle: {
    fontSize: 13,
    fontWeight: 600,
    padding: "12px 16px",
    borderBottom: "1px solid var(--border)",
  } satisfies CSSProperties,
  noAgents: { fontSize: 13, color: "var(--text-muted)", padding: "16px" } satisfies CSSProperties,
  agentRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 16px",
    borderBottom: "1px solid var(--border)",
  } satisfies CSSProperties,
  agentIcon: { color: "var(--text-muted)", flexShrink: 0 } satisfies CSSProperties,
  agentName: { fontSize: 13.5, fontWeight: 500, flex: 1, minWidth: 0 } satisfies CSSProperties,
  openLink: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 12.5,
    fontWeight: 500,
    color: "var(--accent-text)",
    textDecoration: "none",
  } satisfies CSSProperties,
} as const;
