/* AlertBanner — the §8.4 alert, composed CLIENT-SIDE from the structured
   `EvalAlertDetail` (C16) through next-intl.

   The server also emits a plain-English `EvalDashboard.alert` sentence to keep
   the frozen contract honest; this screen deliberately ignores it, because a
   server-built sentence cannot be localised or pluralised (§2.2, §8.4).

   Accessibility (AC-44): the tone drives the colour AND the icon, and every
   metric move carries a glyph plus its "pt" magnitude as text. `role="status"`
   makes the banner announce itself when a new batch changes it. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import type { EvalAlertDetail } from "@devdigest/shared";
import {
  ALERT_METRIC_KEY,
  othersMessageKey,
  primaryMessageKey,
  signalText,
} from "../../helpers";
import { s } from "./styles";

export interface AlertBannerProps {
  detail: EvalAlertDetail;
  /** Used when the batch predates migration 0018 and carries no version. */
  fallbackVersion: number;
}

export function AlertBanner({ detail, fallbackVersion }: AlertBannerProps) {
  const t = useTranslations("eval");
  const version = detail.head_version ?? fallbackVersion;
  const ToneIcon = detail.tone === "warn" ? Icon.AlertTriangle : Icon.TrendingUp;

  const primary = t(primaryMessageKey(detail.primary), {
    pts: Math.abs(detail.primary.delta_pts),
    version,
  });

  // `{metrics}` must arrive with the glyph and the points text already in it:
  // the `others*` messages supply only the sentence frame (AC-44).
  const others =
    detail.others.length > 0
      ? t(othersMessageKey(detail.others), {
          count: detail.others.length,
          metrics: detail.others
            .map((signal) =>
              signalText(signal, t(`dashboard.legend.${ALERT_METRIC_KEY[signal.metric]}`)),
            )
            .join(", "),
        })
      : null;

  return (
    <div role="status" style={s.banner(detail.tone)}>
      <ToneIcon size={16} aria-hidden style={s.icon(detail.tone)} />
      <p style={s.text}>
        <span style={s.primary}>{primary}</span>
        {detail.new_false_positive ? (
          <span style={s.rest}>{` — ${t("dashboard.alert.newFalsePositive")}`}</span>
        ) : null}
        {others === null ? null : <span style={s.rest}>{` ${others}`}</span>}
      </p>
    </div>
  );
}

export default AlertBanner;
