/* SyncStatus — PR-list sync indicator: "Updating…" while a sync runs (AC-59),
   the last successful sync time at all times, and a "showing data from …"
   notice when the last attempt failed — the list itself stays visible (AC-25) —
   and an alert when a manual Refresh could not start a sync. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import type { PrListSync } from "@/lib/types";
import { SYNCED_KEY } from "./constants";
import { formatSyncTime, syncAge } from "./helpers";
import { s } from "./styles";

export function SyncStatus({
  sync,
  updating,
  startFailed = false,
}: {
  /** Sync status from the list page; undefined while the page is loading. */
  sync: PrListSync | undefined;
  /** True while a sync this page started/joined is still running. */
  updating: boolean;
  /** True when the manual Refresh's `POST /pulls/sync` failed. */
  startFailed?: boolean;
}) {
  const t = useTranslations("prReview.list.sync");
  const age = syncAge(sync?.last_synced_at);
  const failed = sync?.state === "failed";
  const failedTime = formatSyncTime(sync?.last_synced_at);

  return (
    <div style={s.wrap}>
      <div role="status" aria-live="polite" style={s.line}>
        {updating && (
          <span style={s.updating}>
            <Icon.RefreshCw size={12} />
            {t("updating")}
          </span>
        )}
        {sync && <span>{age ? t(SYNCED_KEY[age.unit], { count: age.count }) : t("never")}</span>}
      </div>
      {startFailed && (
        <div role="alert" style={s.notice}>
          <Icon.AlertTriangle size={12} />
          {t("startFailed")}
        </div>
      )}
      {failed && (
        <div role="note" style={s.notice} title={sync?.last_sync_error ?? undefined}>
          <Icon.AlertTriangle size={12} />
          {failedTime ? t("failedNotice", { time: failedTime }) : t("failedNoticeNever")}
        </div>
      )}
    </div>
  );
}
