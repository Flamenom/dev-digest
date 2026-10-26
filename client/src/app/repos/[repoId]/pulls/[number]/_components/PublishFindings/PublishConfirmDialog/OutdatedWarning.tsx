/* OutdatedWarning — the confirm dialog's "Outdated review" block (AC-22).
   Rendered inside the modal body (focus trap), before the summary and the
   actions, so it is read before "Publish as deprecated". The state is carried
   by text; the icon is decorative. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import type { PublishPlan } from "@/lib/types";
import { placementLine, reasonLine, type DialogDeprecation } from "./helpers";
import { s } from "./styles";

export interface OutdatedWarningProps {
  deprecation: DialogDeprecation;
  /** The publish plan; undefined while it loads (no placement line yet). */
  plan: PublishPlan | undefined;
}

export function OutdatedWarning({ deprecation, plan }: OutdatedWarningProps) {
  const t = useTranslations("prHost.publish");
  const reason = reasonLine(deprecation);
  const placement = placementLine(plan);

  return (
    <div role="note" aria-label={t("dialog.outdated.heading")} style={s.warning}>
      <span style={s.warningIcon} aria-hidden>
        <Icon.AlertTriangle size={14} />
      </span>
      <div style={s.warningBody}>
        <strong style={s.warningHeading}>{t("dialog.outdated.heading")}</strong>
        <span>
          {reason.kind === "headMoved"
            ? t("dialog.outdated.headMoved", { sha: reason.sha, liveSha: reason.liveSha })
            : reason.kind === "headMovedNoLive"
              ? t("deprecation.notice.headMoved", { sha: reason.sha })
              : t("dialog.outdated.headUnknown")}
        </span>
        {placement?.kind === "some" && (
          <span>{t("dialog.outdated.placementSome", { general: placement.general, total: placement.total })}</span>
        )}
        {placement?.kind === "all" && <span>{t("dialog.outdated.placementAll", { total: placement.total })}</span>}
        {placement?.kind === "unavailable" && <span>{t("dialog.outdated.planUnavailable")}</span>}
        <span>{t("dialog.outdated.noApplicable")}</span>
      </div>
    </div>
  );
}

export default OutdatedWarning;
