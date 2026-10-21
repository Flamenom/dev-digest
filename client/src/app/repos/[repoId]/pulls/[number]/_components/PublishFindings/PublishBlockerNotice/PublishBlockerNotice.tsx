/* PublishBlockerNotice — the single review-level notice while a blocker
   applies (AC-37). Shows the server's message; `review_head_unknown` /
   `review_diff_outdated` offer "Re-run review"; the token blockers reuse the
   comments-spec `GitLabTokenNotice` (Admin link vs Member text). The `id` is
   the `aria-describedby` target of the disabled "Publish N to GitLab" button. */
"use client";

import React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@devdigest/ui";
import { GitLabTokenNotice } from "@/components/gitlab-token-notice";
import { SETTINGS_API_KEYS_HREF } from "@/components/gitlab-token-notice/GitLabTokenNotice/GitLabTokenNotice";
import { useIsAdmin } from "@/lib/hooks/permissions";
import type { PublishBlocker } from "@/lib/types";
import { RERUN_BLOCKERS, TOKEN_MISSING_BLOCKER, TOKEN_NOTICE_HEALTH } from "../constants";
import { s } from "./styles";

export interface PublishBlockerNoticeProps {
  /** Stable element id (see `publishBlockerNoticeId`). */
  id: string;
  blocker: PublishBlocker;
  /** "Re-run review" handler — offered only for the head-unknown / diff-outdated blockers. */
  onRerun?: () => void;
  /** A re-run is being started (button shows a spinner). */
  rerunPending?: boolean;
}

export function PublishBlockerNotice({ id, blocker, onRerun, rerunPending }: PublishBlockerNoticeProps) {
  const t = useTranslations("prHost");
  const isAdmin = useIsAdmin();

  const health = TOKEN_NOTICE_HEALTH[blocker.code];
  if (health) return <GitLabTokenNotice id={id} health={health} />;

  const offerRerun = RERUN_BLOCKERS.has(blocker.code) && !!onRerun;
  return (
    <div role="note" id={id} style={s.box}>
      <span style={s.icon} aria-hidden>
        <Icon.AlertTriangle size={14} />
      </span>
      <div style={s.body}>
        <span>{blocker.message}</span>
        {blocker.code === TOKEN_MISSING_BLOCKER &&
          (isAdmin ? (
            <Link href={SETTINGS_API_KEYS_HREF} style={s.action}>
              {t("tokenNotice.openSettings")}
            </Link>
          ) : (
            <span style={s.muted}>{t("tokenNotice.askAdmin")}</span>
          ))}
        {offerRerun && (
          <Button kind="secondary" size="sm" icon="RefreshCw" loading={rerunPending} onClick={onRerun}>
            {t("publish.rerun")}
          </Button>
        )}
      </div>
    </div>
  );
}

export default PublishBlockerNotice;
