/* GitLabTokenNoticeRegion — the ALWAYS-mounted polite live region that hosts the
   GitLab token notice (spec 2026-10-20-gitlab-comments, AC-25). Screen readers
   only announce content inserted into a live region that already exists, so the
   region stays in the DOM and only its content toggles: the notice appears
   inside it when the token health turns blocking (e.g. after a rejected post). */
"use client";

import React, { type CSSProperties } from "react";
import type { BlockingGitLabHealth } from "@/lib/gitlab-token";
import { GitLabTokenNotice } from "../GitLabTokenNotice/GitLabTokenNotice";
import { GITLAB_TOKEN_NOTICE_ID } from "../GitLabTokenNotice/constants";
import { GITLAB_TOKEN_NOTICE_REGION_TEST_ID } from "./constants";

export interface GitLabTokenNoticeRegionProps {
  /** The blocking token health, or null when nothing is blocked (region stays, empty). */
  health: BlockingGitLabHealth | null;
  /** Page-specific spacing around the notice — applied only while it is shown. */
  wrapStyle?: CSSProperties;
}

export function GitLabTokenNoticeRegion({ health, wrapStyle }: GitLabTokenNoticeRegionProps) {
  return (
    <div aria-live="polite" data-testid={GITLAB_TOKEN_NOTICE_REGION_TEST_ID}>
      {health && (
        <div style={wrapStyle}>
          <GitLabTokenNotice id={GITLAB_TOKEN_NOTICE_ID} health={health} />
        </div>
      )}
    </div>
  );
}

export default GitLabTokenNoticeRegion;
