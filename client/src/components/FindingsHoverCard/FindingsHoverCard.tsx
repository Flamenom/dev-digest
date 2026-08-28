"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon, SeverityBadge, ConfidenceNum, type Severity } from "@devdigest/ui";
import { useDialogBehavior } from "@devdigest/ui/kit/dialog-behavior";
import type { Finding } from "@devdigest/shared";
import {
  SEVERITY_RANK,
  SEVERITY_SEQUENCE,
  groupBySeverity,
  totalCount,
  type SeverityCounts,
} from "./helpers";
import { CLOSE_DELAY_MS, MAX_ROWS, PANEL_WIDTH, s } from "./styles";

/**
 * Findings-by-severity chips + a hover card listing the underlying findings.
 * Shared by the PR list (FINDINGS column), the Agent-runs timeline and the PR
 * brief card. The card uses `position:fixed` so it escapes the PR-list table's
 * `overflow:hidden`; a short close delay lets the pointer cross the gap into
 * the panel.
 *
 * Every prop beyond `findings` / `heading` / `children` is OPTIONAL and off by
 * default, so the original hover-only callers are unaffected:
 *   - `triggerLabel` turns the trigger into a real focusable button and enables
 *     the keyboard path (focus opens, blur/Escape close, focus returns);
 *   - `groupBySeverity` renders one labelled block per severity;
 *   - `maxRows` lifts the "+N more" cap (pass `Infinity` to list everything).
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

interface PanelBodyProps {
  rows: Finding[];
  grouped: boolean;
  more: number;
  heading: string;
  loading: boolean;
}

function PanelBody({ rows, grouped, more, heading, loading }: PanelBodyProps) {
  const t = useTranslations("prReview");
  return (
    <>
      <div style={s.heading}>{heading}</div>
      {rows.length === 0 ? (
        <div style={s.muted}>{loading ? t("findings.loading") : t("findings.none")}</div>
      ) : grouped ? (
        groupBySeverity(rows).map((g) => (
          <div key={g.severity} style={s.group}>
            <div style={s.groupHead}>
              {/* Non-compact: the compact badge is icon-only, and AC-20 wants the
                  severity NAME readable at the head of each group. */}
              {SEVERITY_SEQUENCE.includes(g.severity) ? (
                <SeverityBadge severity={g.severity} count={g.findings.length} />
              ) : (
                <span style={s.groupFallback}>
                  {g.severity} {g.findings.length}
                </span>
              )}
            </div>
            <div style={s.list}>
              {g.findings.map((f) => (
                <FindingRow key={f.id} f={f} />
              ))}
            </div>
          </div>
        ))
      ) : (
        <div style={s.list}>
          {rows.map((f) => (
            <FindingRow key={f.id} f={f} />
          ))}
        </div>
      )}
      {more > 0 && <div style={s.more}>{t("findings.more", { count: more })}</div>}
    </>
  );
}

interface PanelProps extends PanelBodyProps {
  top: number;
  left: number;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

/** Hover-only panel: a passive tooltip, no focus or keyboard involvement. */
function TooltipPanel({ top, left, onMouseEnter, onMouseLeave, ...body }: PanelProps) {
  return (
    <div role="tooltip" style={s.panel(top, left)} {...{ onMouseEnter, onMouseLeave }}>
      <PanelBody {...body} />
    </div>
  );
}

/**
 * Keyboard-opened panel. `useDialogBehavior` is the shared WAI-ARIA dialog hook:
 * it registers this layer on the module-level `dialogStack`, so Escape is only
 * consumed when this panel is the TOPMOST layer (a bare `document` keydown
 * listener made one Escape close every open layer — see client/INSIGHTS.md),
 * moves focus into the panel and restores it to the trigger on unmount.
 */
function DialogPanel({
  top,
  left,
  onClose,
  onMouseEnter,
  onMouseLeave,
  ...body
}: PanelProps & { onClose: () => void }) {
  const { panelRef } = useDialogBehavior(onClose);
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={body.heading}
      tabIndex={-1}
      style={s.panel(top, left)}
      {...{ onMouseEnter, onMouseLeave }}
    >
      <PanelBody {...body} />
    </div>
  );
}

export function FindingsHoverCard({
  findings,
  heading,
  loading = false,
  children,
  onHoverStart,
  triggerLabel,
  groupBySeverity: grouped = false,
  maxRows = MAX_ROWS,
}: {
  findings: Finding[];
  /** Already-localized panel heading, e.g. "6 findings". */
  heading: string;
  /** Show a loading note when findings are still being fetched. */
  loading?: boolean;
  /** The trigger (chips). Rendered inline; the card hangs off its bounding rect. */
  children: React.ReactNode;
  /** Fired the first time the card opens — lets callers lazily fetch findings. */
  onHoverStart?: () => void;
  /**
   * Opt in to the keyboard path: wraps `children` in a focusable button with
   * this accessible name. Focus opens the panel as a `role="dialog"`, blur and
   * Escape close it, and focus returns to the trigger. Omitted → hover only,
   * exactly as before.
   */
  triggerLabel?: string;
  /** Render one labelled block per severity instead of one flat list. */
  groupBySeverity?: boolean;
  /** Rows before the "+N more" footer caps the panel. `Infinity` lists all. */
  maxRows?: number;
}) {
  const [open, setOpen] = React.useState(false);
  // Opened from the keyboard → the panel becomes a real dialog layer.
  const [dialog, setDialog] = React.useState(false);
  const [pos, setPos] = React.useState({ top: 0, left: 0 });
  const wrapRef = React.useRef<HTMLSpanElement>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Closing a dialog panel restores focus to the trigger; that focus event must
  // not immediately re-open the panel we were just asked to dismiss.
  const ignoreFocus = React.useRef(false);
  const unguard = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusable = triggerLabel !== undefined;

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
  const close = () => {
    clear();
    // The dialog's unmount cleanup re-focuses the trigger synchronously during
    // this commit; release the guard once that has flushed.
    ignoreFocus.current = true;
    setOpen(false);
    setDialog(false);
    if (unguard.current) clearTimeout(unguard.current);
    unguard.current = setTimeout(() => {
      unguard.current = null;
      ignoreFocus.current = false;
    }, 0);
  };
  /** Deferred close — cancelled if the pointer re-enters or focus is still inside. */
  const hide = () => {
    clear();
    timer.current = setTimeout(() => {
      timer.current = null;
      const el = wrapRef.current;
      if (el && typeof document !== "undefined" && el.contains(document.activeElement)) return;
      setOpen(false);
      setDialog(false);
    }, CLOSE_DELAY_MS);
  };
  const onTriggerFocus = () => {
    if (ignoreFocus.current) return;
    clear();
    if (dialog) return;
    show();
    setDialog(true);
  };
  React.useEffect(
    () => () => {
      clear();
      if (unguard.current) clearTimeout(unguard.current);
    },
    [],
  );

  const sorted = [...findings].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9),
  );
  const rows = Number.isFinite(maxRows) ? sorted.slice(0, maxRows) : sorted;
  const panel = {
    top: pos.top,
    left: pos.left,
    rows,
    grouped,
    more: sorted.length - rows.length,
    heading,
    loading,
    onMouseEnter: show,
    onMouseLeave: hide,
  };

  return (
    <span
      ref={wrapRef}
      style={s.wrap}
      onMouseEnter={show}
      onMouseLeave={hide}
      {...(focusable ? { onFocus: onTriggerFocus, onBlur: hide } : {})}
    >
      {focusable ? (
        // A disclosure trigger driven by focus/hover: focusing it opens the
        // panel, which immediately takes focus, so a click handler would only
        // ever race the focus handler.
        <button
          type="button"
          aria-label={triggerLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          style={s.trigger}
        >
          {children}
        </button>
      ) : (
        children
      )}
      {open &&
        (dialog ? <DialogPanel {...panel} onClose={close} /> : <TooltipPanel {...panel} />)}
    </span>
  );
}

export { totalCount };
export type { SeverityCounts };
