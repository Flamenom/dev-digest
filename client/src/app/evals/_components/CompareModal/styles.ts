/* styles.ts — inline CSSProperties + CSS tokens (client/CLAUDE.md: no Tailwind
   utility classes anywhere in this app). */
import type { CSSProperties } from "react";

import type { DeltaTone } from "./helpers";
import type { EvalPromptDiffLine } from "@devdigest/shared";

/** Green when a metric moved the good way, red the bad way, muted when flat or
    unknown. Always redundant with the glyph + "pt" text (AC-44). */
function toneColor(tone: DeltaTone, higherIsBetter: boolean): string {
  if (tone === "up") return higherIsBetter ? "var(--ok)" : "var(--crit)";
  if (tone === "down") return higherIsBetter ? "var(--crit)" : "var(--ok)";
  return "var(--text-muted)";
}

export const s = {
  body: {
    display: "flex",
    flexDirection: "column",
    gap: 20,
    padding: "20px 24px",
  } satisfies CSSProperties,

  /* ---- not-comparable strip (above the delta cards, §9.1) ---- */
  warn: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid var(--warn)",
    background: "var(--warn-bg)",
    color: "var(--text-primary)",
    fontSize: 13,
    lineHeight: 1.5,
  } satisfies CSSProperties,
  warnBody: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  } satisfies CSSProperties,
  warnCount: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  changedCaseIds: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    margin: 0,
    padding: 0,
    listStyle: "none",
  } satisfies CSSProperties,
  changedCaseId: {
    fontSize: 11.5,
    color: "var(--text-muted)",
    background: "var(--bg-hover)",
    borderRadius: 4,
    padding: "1px 6px",
  } satisfies CSSProperties,

  /* ---- delta cards ---- */
  cards: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
    gap: 12,
  } satisfies CSSProperties,
  card: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "12px 14px",
    borderRadius: 10,
    border: "1px solid var(--border)",
    background: "var(--bg-surface)",
  } satisfies CSSProperties,
  cardLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.07em",
    textTransform: "uppercase",
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  cardValues: {
    fontSize: 15,
    fontWeight: 600,
    color: "var(--text-primary)",
  } satisfies CSSProperties,
  cardDelta: (tone: DeltaTone, higherIsBetter: boolean) =>
    ({
      fontSize: 13,
      fontWeight: 700,
      color: toneColor(tone, higherIsBetter),
    }) satisfies CSSProperties,

  /* ---- system prompt diff ---- */
  legend: {
    display: "flex",
    gap: 14,
    marginBottom: 8,
    fontSize: 12,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  legendOld: { color: "var(--crit)" } satisfies CSSProperties,
  legendNew: { color: "var(--ok)" } satisfies CSSProperties,
  diffBlock: {
    margin: 0,
    padding: "10px 0",
    maxHeight: 280,
    overflow: "auto",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--code-bg)",
    fontFamily: "var(--font-mono)",
    fontSize: 12.5,
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  } satisfies CSSProperties,
  diffLine: (kind: EvalPromptDiffLine["kind"]) =>
    ({
      padding: "0 12px",
      color:
        kind === "added"
          ? "var(--code-add-text)"
          : kind === "removed"
            ? "var(--code-del-text)"
            : "var(--text-secondary)",
      background:
        kind === "added"
          ? "var(--code-add)"
          : kind === "removed"
            ? "var(--code-del)"
            : "transparent",
    }) satisfies CSSProperties,
  note: {
    fontSize: 13,
    lineHeight: 1.5,
    color: "var(--text-secondary)",
    padding: "14px 16px",
    borderRadius: 8,
    border: "1px dashed var(--border-strong)",
    background: "var(--bg-surface)",
  } satisfies CSSProperties,

  /* ---- footer ---- */
  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 10,
  } satisfies CSSProperties,
  confirmFooter: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
  } satisfies CSSProperties,
  confirmCopy: {
    fontSize: 13,
    lineHeight: 1.5,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
} as const;
