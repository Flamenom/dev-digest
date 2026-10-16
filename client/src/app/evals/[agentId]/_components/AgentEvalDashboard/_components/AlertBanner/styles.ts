/* styles.ts — inline CSSProperties + CSS tokens (no Tailwind). */
import type { CSSProperties } from "react";
import type { EvalAlertDetail } from "@devdigest/shared";

type Tone = EvalAlertDetail["tone"];

/** Amber on a regression, neutral blue otherwise (§8.4 rule 6). The tone is
    ALWAYS redundant with the icon and the sentence — never colour alone (AC-44). */
export const s = {
  banner: (tone: Tone): CSSProperties => ({
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "12px 16px",
    borderRadius: 9,
    border: `1px solid ${tone === "warn" ? "var(--warn)" : "var(--accent)"}`,
    background: tone === "warn" ? "var(--warn-bg)" : "var(--accent-bg)",
    color: "var(--text-primary)",
  }),
  icon: (tone: Tone): CSSProperties => ({
    flexShrink: 0,
    marginTop: 1,
    color: tone === "warn" ? "var(--warn)" : "var(--accent)",
  }),
  text: {
    fontSize: 13.5,
    lineHeight: 1.55,
  } satisfies CSSProperties,
  primary: {
    fontWeight: 700,
  } satisfies CSSProperties,
  rest: {
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
};
