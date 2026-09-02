/* RunAllSummary — the `▷ Run all agents` outcome strip (R12 / AC-34).

   Purely derived from the mutation's own `data`, so nothing is mirrored into
   component state (react-best-practices: derive, don't store). One line per
   skipped agent with its reason spelled out — a silent skip is what makes the
   button feel broken. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import type { EvalRunAllResult } from "@devdigest/shared";
import { SKIP_REASON_KEY } from "../../constants";
import { s } from "../../styles";

export interface RunAllSummaryProps {
  result: EvalRunAllResult;
}

export function RunAllSummary({ result }: RunAllSummaryProps) {
  const t = useTranslations("eval");
  const tAgents = useTranslations("agents");

  const reasonText = (reason: EvalRunAllResult["skipped"][number]["reason"]): string =>
    reason === "disabled" ? tAgents("editor.disabled") : t(SKIP_REASON_KEY[reason]);

  return (
    <div style={s.runAllSummary} role="status">
      {/* The started batches have no names in C23, only ids — the row-cards
          above already show each agent's live progress, so this line only
          reports how many were kicked off. */}
      <span style={s.runAllStarted}>
        <Icon.Play size={13} />
        {t("dashboard.running")}
        <span className="tnum">{result.started.length}</span>
      </span>
      {result.skipped.length > 0 && (
        <ul style={s.skipList}>
          {result.skipped.map((skip) => (
            <li key={skip.agent_id} style={s.skipRow}>
              <Icon.Slash size={12} style={s.skipIcon} />
              <span style={s.skipAgent}>{skip.agent_name}</span>
              <span style={s.skipReason}>{reasonText(skip.reason)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default RunAllSummary;
