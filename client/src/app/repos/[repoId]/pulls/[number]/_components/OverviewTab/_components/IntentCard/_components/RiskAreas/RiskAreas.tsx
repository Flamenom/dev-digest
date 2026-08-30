/* RiskAreas — the PR Brief's grounded risks, rendered inside the Intent card's
   RISK AREAS block in place of the intent's free-text labels (AC-22). Collapsed
   a row shows a severity glyph, the title and the primary file ref; expanding
   reveals the explanation and every ref (AC-24). Refs are buttons that hand the
   path + line back to the page (AC-25) — this component owns no routing.
   Titles/explanations are model output: plain text nodes only (NFR-6). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import type { BriefRisk, BriefRiskRef } from "@devdigest/shared";
import { RISK_CHEVRON_SIZE, RISK_ICON_SIZE, SEVERITY_TONE } from "./constants";
import { refLabel, riskIcon } from "./helpers";
import { s } from "./styles";

/** Navigate to a risk's file reference; supplied by the page (T17). */
export type GoToRef = (path: string, line: number) => void;

export function RiskAreas({
  risks,
  onGoToRef,
}: {
  risks: BriefRisk[];
  onGoToRef?: GoToRef;
}) {
  return (
    <ul style={s.list}>
      {risks.map((risk, i) => (
        // Index-qualified: two risks may share a kind + title, and the string
        // alone would collide (the bug in the free-text chip list this replaces).
        <RiskRow key={`${i}:${risk.kind}:${risk.title}`} risk={risk} onGoToRef={onGoToRef} />
      ))}
    </ul>
  );
}

/** One risk. Expansion state is local to the row — the card never lifts it. */
function RiskRow({ risk, onGoToRef }: { risk: BriefRisk; onGoToRef?: GoToRef }) {
  const t = useTranslations("brief");
  const [open, setOpen] = React.useState(false);
  const bodyId = React.useId();

  const tone = SEVERITY_TONE[risk.severity];
  const KindIcon = Icon[riskIcon(risk)];
  const primary = risk.refs[0];
  const extraRefs = risk.refs.length - 1;

  return (
    <li style={s.row}>
      <div style={s.rowHead}>
        <div style={s.rowMain}>
          {/* Severity is never colour-alone: the glyph carries the band as text. */}
          <KindIcon
            size={RISK_ICON_SIZE}
            role="img"
            aria-label={t(`card.riskLevel.${risk.severity}`)}
            style={s.severityIcon(tone.c)}
          />
          <div style={s.rowText}>
            <span style={s.title}>{risk.title}</span>
            {!open && primary && (
              <span style={s.refLine}>
                <RefButton refItem={primary} onGoToRef={onGoToRef} />
                {extraRefs > 0 && (
                  <span style={s.moreRefs}>{t("risks.moreRefs", { count: extraRefs })}</span>
                )}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          style={s.toggle}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={open ? t("risks.collapse") : t("risks.expand")}
          onClick={() => setOpen((prev) => !prev)}
        >
          <Icon.ChevronDown size={RISK_CHEVRON_SIZE} style={s.chevron(open)} />
        </button>
      </div>

      {open && (
        <div id={bodyId} style={s.body}>
          <p style={s.explanation}>{risk.explanation}</p>
          {risk.refs.length > 0 && (
            <ul style={s.refList}>
              {risk.refs.map((ref, i) => (
                <li key={`${i}:${ref.path}:${ref.start_line}`}>
                  <RefButton refItem={ref} onGoToRef={onGoToRef} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/** A `path:line` affordance — same shape as the Blast card's caller links. */
function RefButton({ refItem, onGoToRef }: { refItem: BriefRiskRef; onGoToRef?: GoToRef }) {
  const label = refLabel(refItem);
  return (
    <button
      type="button"
      className="mono"
      style={s.refBtn}
      title={label}
      onClick={() => onGoToRef?.(refItem.path, refItem.start_line)}
    >
      {label}
    </button>
  );
}

export default RiskAreas;
