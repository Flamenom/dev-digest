/* Inline style objects for the /evals overview — CSS tokens only (`var(--…)`),
   never Tailwind utility classes (client/CLAUDE.md). */
import type { CSSProperties } from "react";

export const s = {
  page: {
    height: "calc(100vh - 52px)",
    overflowY: "auto",
    padding: "28px 32px 48px",
  } satisfies CSSProperties,
  inner: {
    maxWidth: 1080,
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    gap: 22,
  } satisfies CSSProperties,
  centered: {
    maxWidth: 1080,
    margin: "0 auto",
    paddingTop: 48,
  } satisfies CSSProperties,
  skeletons: {
    maxWidth: 1080,
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  } satisfies CSSProperties,
  headerRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
  } satisfies CSSProperties,
  heading: {
    margin: 0,
    fontSize: 22,
    fontWeight: 650,
    color: "var(--text-primary)",
    display: "flex",
    alignItems: "center",
    gap: 10,
  } satisfies CSSProperties,
  subtitle: {
    marginTop: 6,
    fontSize: 13,
    color: "var(--text-muted)",
    maxWidth: 620,
  } satisfies CSSProperties,
  section: {
    display: "flex",
    flexDirection: "column",
  } satisfies CSSProperties,
  agentList: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  } satisfies CSSProperties,

  /* --- run-all result strip ------------------------------------------- */
  runAllSummary: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: "12px 14px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--bg-elevated)",
    fontSize: 13,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  runAllStarted: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    color: "var(--text-primary)",
    fontWeight: 600,
  } satisfies CSSProperties,
  skipList: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  } satisfies CSSProperties,
  skipRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  } satisfies CSSProperties,
  skipIcon: {
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  skipAgent: {
    color: "var(--text-primary)",
    fontWeight: 600,
  } satisfies CSSProperties,
  skipReason: {
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  /* --- recent runs table ------------------------------------------------ */
  tableWrap: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    overflowX: "auto",
    background: "var(--bg-elevated)",
  } satisfies CSSProperties,
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 13,
  } satisfies CSSProperties,
  th: {
    textAlign: "left",
    padding: "10px 14px",
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
    padding: "10px 14px",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--text-muted)",
    borderBottom: "1px solid var(--border)",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  td: {
    padding: "10px 14px",
    borderBottom: "1px solid var(--border)",
    color: "var(--text-secondary)",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  tdNum: {
    padding: "10px 14px",
    borderBottom: "1px solid var(--border)",
    color: "var(--text-primary)",
    textAlign: "right",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  tdVersion: {
    marginLeft: 8,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  tdAgent: {
    padding: "10px 14px",
    borderBottom: "1px solid var(--border)",
    color: "var(--text-primary)",
    fontWeight: 600,
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  runningCell: {
    padding: "10px 14px",
    borderBottom: "1px solid var(--border)",
  } satisfies CSSProperties,
  runningInner: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  } satisfies CSSProperties,
  runningIcon: {
    marginRight: 6,
    verticalAlign: "-2px",
  } satisfies CSSProperties,
  runningLabel: {
    color: "var(--accent)",
    fontWeight: 600,
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  runningBar: {
    flex: 1,
    minWidth: 80,
    maxWidth: 220,
  } satisfies CSSProperties,
  runningCount: {
    color: "var(--text-muted)",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  emptyRow: {
    padding: "22px 14px",
    textAlign: "center",
    color: "var(--text-muted)",
  } satisfies CSSProperties,
};

/* --- agent row-card ----------------------------------------------------- */
export const c = {
  agentIcon: {
    color: "var(--accent)",
    flexShrink: 0,
  } satisfies CSSProperties,
  link: {
    display: "block",
    textDecoration: "none",
    color: "inherit",
  } satisfies CSSProperties,
  card: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    padding: "14px 16px",
  } satisfies CSSProperties,
  identity: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    minWidth: 0,
    flex: 1,
  } satisfies CSSProperties,
  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minWidth: 0,
    flexWrap: "wrap",
  } satisfies CSSProperties,
  name: {
    fontSize: 15,
    fontWeight: 650,
    color: "var(--text-primary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  subLine: {
    fontSize: 12.5,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  stats: {
    display: "flex",
    alignItems: "center",
    gap: 22,
  } satisfies CSSProperties,
  stat: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 2,
    minWidth: 62,
  } satisfies CSSProperties,
  statLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.06em",
    color: "var(--text-muted)",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  statValue: {
    fontSize: 17,
    fontWeight: 700,
    color: "var(--text-primary)",
  } satisfies CSSProperties,
  progress: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    minWidth: 180,
  } satisfies CSSProperties,
  progressLabel: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12.5,
    color: "var(--accent)",
    fontWeight: 600,
  } satisfies CSSProperties,
  chevron: {
    color: "var(--text-muted)",
    flexShrink: 0,
  } satisfies CSSProperties,
};
