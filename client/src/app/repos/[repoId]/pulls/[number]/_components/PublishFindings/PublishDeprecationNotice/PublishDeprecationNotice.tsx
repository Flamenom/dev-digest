/* PublishDeprecationNotice — the review-level, NON-blocking warning shown
   while the preview reports a deprecation (spec
   2026-10-23-gitlab-publish-outdated-findings, AC-20). The wording depends on
   the reason; a `head_moved` SHA that is not lowercase hex falls back to the
   `head_unknown` wording (Q6). Offers "Re-run review". The `id` is the
   `aria-describedby` target of the (still enabled) "Publish N to GitLab"
   button. The icon is decorative — the state is conveyed by the text. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@devdigest/ui";
import type { PublishDeprecation } from "@/lib/types";
import { shortSha } from "../helpers";
import { s } from "./styles";

export interface PublishDeprecationNoticeProps {
  /** Stable element id (see `publishDeprecationNoticeId`). */
  id: string;
  deprecation: PublishDeprecation;
  /** "Re-run review" handler; omitted → no button. */
  onRerun?: () => void;
  /** A re-run is being started (button shows a spinner). */
  rerunPending?: boolean;
}

/** Stable, per-review id of the deprecation notice (`aria-describedby` target). */
export function publishDeprecationNoticeId(reviewId: string): string {
  return `publish-deprecation-${reviewId}`;
}

export function PublishDeprecationNotice({ id, deprecation, onRerun, rerunPending }: PublishDeprecationNoticeProps) {
  const t = useTranslations("prHost.publish");
  const sha = deprecation.reason === "head_moved" ? shortSha(deprecation.reviewed_head_sha) : null;
  const text = sha ? t("deprecation.notice.headMoved", { sha }) : t("deprecation.notice.headUnknown");

  return (
    <div role="note" id={id} style={s.box}>
      <span style={s.icon} aria-hidden>
        <Icon.AlertTriangle size={14} />
      </span>
      <div style={s.body}>
        <span>{text}</span>
        {onRerun && (
          <Button kind="secondary" size="sm" icon="RefreshCw" loading={rerunPending} onClick={onRerun}>
            {t("rerun")}
          </Button>
        )}
      </div>
    </div>
  );
}

export default PublishDeprecationNotice;
