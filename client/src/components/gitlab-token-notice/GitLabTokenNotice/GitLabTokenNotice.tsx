/* GitLabTokenNotice — persistent, non-dismissible notice shown on the PR list
   and the PR page while the stored GitLab token is known bad (spec
   2026-10-20-gitlab-comments, AC-25). Admins get a link to Settings → API
   Keys; Members (and everyone while the session probe is pending — fail
   closed) get "Ask an admin to update it." The stable `id` is the
   `aria-describedby` target of the disabled post button. */
"use client";

import React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import { useIsAdmin } from "@/lib/hooks/permissions";
import type { GitLabTokenHealth } from "@/lib/types";
import { s } from "./styles";

/** The health values that render the notice (the blocking ones). */
export type BlockingGitLabHealth = Extract<GitLabTokenHealth, "insufficient_scope" | "invalid">;

const MESSAGE_KEY = {
  insufficient_scope: "insufficientScope",
  invalid: "invalid",
} as const satisfies Record<BlockingGitLabHealth, string>;

export const SETTINGS_API_KEYS_HREF = "/settings/api-keys";

export interface GitLabTokenNoticeProps {
  /** Stable element id — referenced by `aria-describedby` on blocked controls. */
  id: string;
  health: BlockingGitLabHealth;
}

export function GitLabTokenNotice({ id, health }: GitLabTokenNoticeProps) {
  const t = useTranslations("prHost.tokenNotice");
  const isAdmin = useIsAdmin();

  return (
    <div role="note" id={id} style={s.box}>
      <span style={s.icon} aria-hidden>
        <Icon.AlertTriangle size={14} />
      </span>
      <div style={s.body}>
        <span>{t(MESSAGE_KEY[health])}</span>
        {isAdmin ? (
          <Link href={SETTINGS_API_KEYS_HREF} style={s.action}>
            {t("openSettings")}
          </Link>
        ) : (
          <span style={s.muted}>{t("askAdmin")}</span>
        )}
      </div>
    </div>
  );
}

export default GitLabTokenNotice;
