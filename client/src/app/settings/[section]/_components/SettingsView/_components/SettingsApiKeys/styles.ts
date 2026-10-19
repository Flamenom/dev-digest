import type { CSSProperties } from "react";
import type { SecretState } from "@devdigest/shared";

const BADGE_COLOR: Record<SecretState, string> = {
  set: "var(--ok)",
  unset: "var(--text-muted)",
  undecryptable: "var(--warn)",
};

/** Co-located styles for SettingsApiKeys + its KeyRow. */
export const s = {
  wrap: { maxWidth: 640 } satisfies CSSProperties,
  keyRow: { display: "flex", gap: 10, alignItems: "center" } satisfies CSSProperties,
  keyInput: { flex: 1 } satisfies CSSProperties,
  revealIcon: { color: "var(--text-muted)", cursor: "pointer" } satisfies CSSProperties,
  result: (ok: boolean): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
    fontSize: 13,
    color: ok ? "var(--ok)" : "var(--crit)",
    fontWeight: 600,
  }),
  badge: (state: SecretState): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    fontWeight: 600,
    color: BADGE_COLOR[state],
  }),
  badgeDot: (state: SecretState): CSSProperties => ({
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: BADGE_COLOR[state],
  }),
  /** Member view: one bordered row per key (label + hint, badge on the right). */
  readOnlyRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 0",
    borderBottom: "1px solid var(--border)",
  } satisfies CSSProperties,
  readOnlyText: { flex: 1, minWidth: 0 } satisfies CSSProperties,
  readOnlyLabel: { fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" } satisfies CSSProperties,
  readOnlyHint: { fontSize: 12, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.45 } satisfies CSSProperties,
  notice: {
    display: "flex",
    gap: 10,
    alignItems: "center",
    marginBottom: 16,
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--bg-surface)",
    fontSize: 13,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
} as const;
