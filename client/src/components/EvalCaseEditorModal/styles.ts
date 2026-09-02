import type { CSSProperties } from "react";

/** Co-located styles for EvalCaseEditorModal — CSS tokens only, no Tailwind. */
export const s = {
  body: { padding: "20px 24px" } satisfies CSSProperties,

  /* --- header row of a field (label + right-hand affordance) --- */
  labelRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  } satisfies CSSProperties,

  kindRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12,
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  /* --- input tabs --- */
  tabPanel: {
    border: "1px solid var(--border)",
    borderTop: "none",
    borderRadius: "0 0 7px 7px",
    padding: 12,
    background: "var(--bg-surface)",
  } satisfies CSSProperties,

  metaField: { marginBottom: 12 } satisfies CSSProperties,

  /* --- notices --- */
  warnBlock: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    marginTop: 10,
  } satisfies CSSProperties,

  warn: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    fontSize: 12.5,
    lineHeight: 1.5,
    color: "var(--warn)",
    background: "var(--bg-hover)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: "8px 10px",
  } satisfies CSSProperties,

  warnIcon: { flexShrink: 0, marginTop: 2 } satisfies CSSProperties,

  note: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12.5,
    color: "var(--text-muted)",
    lineHeight: 1.5,
    marginBottom: 16,
  } satisfies CSSProperties,

  link: { color: "var(--accent)", textDecoration: "none" } satisfies CSSProperties,

  /* --- last-run strip --- */
  lastRun: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
    borderRadius: 7,
    border: "1px solid var(--border)",
    background: "var(--bg-surface)",
    fontSize: 13,
    marginBottom: 16,
  } satisfies CSSProperties,

  lastRunMeta: { fontSize: 12, color: "var(--text-muted)" } satisfies CSSProperties,

  /* --- delete confirmation --- */
  confirm: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
    padding: "10px 12px",
    borderRadius: 7,
    border: "1px solid var(--crit)",
    background: "var(--crit-bg)",
    fontSize: 12.5,
    lineHeight: 1.5,
    color: "var(--text-primary)",
    marginBottom: 16,
  } satisfies CSSProperties,

  /* --- footer --- */
  footer: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  } satisfies CSSProperties,

  footerSpacer: { flex: 1 } satisfies CSSProperties,

  runOnSave: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12.5,
    color: "var(--text-secondary)",
    cursor: "pointer",
  } satisfies CSSProperties,

  loading: {
    padding: "32px 24px",
    fontSize: 13,
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  /* --- screen F layout: input on the left, expected + actual on the right --- */
  grid: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
    gap: 24,
    padding: "20px 24px",
    alignItems: "start",
  } satisfies CSSProperties,

  col: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
    minWidth: 0,
  } satisfies CSSProperties,

  /* --- "what this case asserts", stated before the JSON --- */
  kindBanner: (kind: "must_find" | "must_not_flag"): CSSProperties => ({
    border: `1px solid ${kind === "must_not_flag" ? "var(--warn)" : "var(--ok)"}`,
    background: kind === "must_not_flag" ? "var(--warn-bg)" : "var(--ok-bg)",
    borderRadius: 8,
    padding: "10px 14px",
  }),

  kindBannerTitle: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  } satisfies CSSProperties,

  kindBannerBody: {
    marginTop: 2,
    fontSize: 13,
    color: "var(--text-muted)",
  } satisfies CSSProperties,

  /* --- read-only actual output: a pre, not a disabled textarea --- */
  actualBox: {
    margin: 0,
    padding: "10px 12px",
    minHeight: 220,
    maxHeight: 320,
    overflow: "auto",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-inset)",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    lineHeight: 1.55,
    whiteSpace: "pre",
    color: "var(--text)",
  } satisfies CSSProperties,

  actualEmpty: {
    color: "var(--text-muted)",
  } satisfies CSSProperties,
} as const;
