"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon, SeverityBadge, ConfidenceNum, type Severity } from "@devdigest/ui";
import type { Finding } from "@devdigest/shared";
import {
  SEVERITY_RANK,
  SEVERITY_SEQUENCE,
  totalCount,
  type SeverityCounts,
} from "./helpers";
import { MAX_ROWS, PANEL_WIDTH, s } from "./styles";

/**
 * Findings-by-severity chips + a hover card listing the underlying findings.
 * Shared by the PR list (FINDINGS column) and the Agent-runs timeline. The card
 * uses `position:fixed` so it escapes the PR-list table's `overflow:hidden`; a
 * short close delay lets the pointer cross the gap into the panel.
 */

/** One compact `SeverityBadge` per non-zero severity; a green check when clean. */
export function FindingsSeverityChips({ counts }: { counts: SeverityCounts }) {
  const shown = SEVERITY_SEQUENCE.filter((sev) => counts[sev] > 0);
  if (shown.length === 0) {
    return <Icon.CheckCircle size={15} style={{ color: "var(--ok)" }} />;
  }
  return (
    <span style={s.chips}>
      {shown.map((sev) => (
        <SeverityBadge key={sev} severity={sev} count={counts[sev]} compact />
      ))}
    </span>
  );
}

function FindingRow({ f }: { f: Finding }) {
  return (
    <div style={s.row}>
      <div style={s.rowHead}>
        <SeverityBadge severity={f.severity as Severity} compact />
        <span style={s.rowTitle}>{f.title}</span>
      </div>
      <div style={s.rowMeta}>
        <span className="mono" style={s.rowFile}>
          {f.file}:{f.start_line}
        </span>
        <ConfidenceNum value={f.confidence} />
      </div>
      <div style={s.rowRationale}>{f.rationale}</div>
    </div>
  );
}

export function FindingsHoverCard({
  findings,
  heading,
  loading = false,
  children,
  onHoverStart,
}: {
  findings: Finding[];
  /** Already-localized panel heading, e.g. "6 findings". */
  heading: string;
  /** Show a loading note when findings are still being fetched. */
  loading?: boolean;
  /** The trigger (chips). Rendered inline; the card hangs off its bounding rect. */
  children: React.ReactNode;
  /** Fired on first hover — lets callers lazily fetch the findings. */
  onHoverStart?: () => void;
}) {
  const t = useTranslations("prReview");
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState({ top: 0, left: 0 });
  const wrapRef = React.useRef<HTMLSpanElement>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const show = () => {
    clear();
    onHoverStart?.();
    const el = wrapRef.current;
    if (el && typeof window !== "undefined") {
      const r = el.getBoundingClientRect();
      const left = Math.max(12, Math.min(r.left, window.innerWidth - PANEL_WIDTH - 12));
      setPos({ top: r.bottom + 6, left });
    }
    setOpen(true);
  };
  const hide = () => {
    clear();
    timer.current = setTimeout(() => setOpen(false), 120);
  };
  React.useEffect(() => () => clear(), []);

  const sorted = [...findings].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9),
  );
  const rows = sorted.slice(0, MAX_ROWS);
  const more = sorted.length - rows.length;

  return (
    <span ref={wrapRef} style={s.wrap} onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {open && (
        <div style={s.panel(pos.top, pos.left)} onMouseEnter={show} onMouseLeave={hide}>
          <div style={s.heading}>{heading}</div>
          {rows.length === 0 ? (
            <div style={s.muted}>
              {loading ? t("findings.loading") : t("findings.none")}
            </div>
          ) : (
            <div style={s.list}>
              {rows.map((f) => (
                <FindingRow key={f.id} f={f} />
              ))}
            </div>
          )}
          {more > 0 && <div style={s.more}>{t("findings.more", { count: more })}</div>}
        </div>
      )}
    </span>
  );
}

export { totalCount };
export type { SeverityCounts };
