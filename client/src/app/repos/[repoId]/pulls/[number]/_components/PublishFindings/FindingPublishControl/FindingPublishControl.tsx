/* FindingPublishControl — a finding's publish affordance (AC-36):
   - publishable → a checkbox ("Select <title> (<file:lines>)"); off-diff
     findings add "Posts as a general MR comment (not on a changed line)";
   - unpublishable → an inert checkbox described by the visible reason text
     (state is never conveyed by color alone);
   - published → "Published by <name> · <time>" + "View on GitLab" (only for
     an http/https URL, new tab, `rel="noopener noreferrer"`), or "Published —
     link unavailable".
   Clicks are contained so a host card's header toggle never fires. */
"use client";

import React, { useId } from "react";
import { useTranslations } from "next-intl";
import { Checkbox, Icon } from "@devdigest/ui";
import type { PublishPreviewFinding } from "@/lib/types";
import { anchorLocation, formatPublishedAt, isSafeHttpUrl } from "../helpers";
import { s } from "./styles";

export interface FindingPublishControlProps {
  entry: PublishPreviewFinding;
  /** The finding's title (part of the checkbox's accessible name). */
  title: string;
  checked: boolean;
  onToggle: (findingId: string) => void;
  /** Selection is frozen (a publication is in progress, AC-39). */
  disabled?: boolean;
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

export function FindingPublishControl({ entry, title, checked, onToggle, disabled = false }: FindingPublishControlProps) {
  const t = useTranslations("prHost.publish");
  const reasonId = useId();

  if (entry.published) {
    const { published_by, published_at, url } = entry.published;
    return (
      <span style={s.root} onClick={stop} onKeyDown={stop}>
        <span style={s.published}>
          <Icon.CheckCircle size={13} style={s.publishedIcon} aria-hidden />
          {t("publishedBy", { name: published_by?.name ?? "—", time: formatPublishedAt(published_at) })}
        </span>
        {isSafeHttpUrl(url) ? (
          <a href={url} target="_blank" rel="noopener noreferrer" style={s.link}>
            {t("viewOnGitLab")}
            <Icon.ExternalLink size={12} aria-hidden />
          </a>
        ) : (
          <span style={s.note}>{t("publishedLinkUnavailable")}</span>
        )}
      </span>
    );
  }

  const label = <span style={s.srOnly}>{t("select", { title, location: anchorLocation(entry.anchor) })}</span>;

  if (!entry.publishable) {
    return (
      <span style={s.root} onClick={stop} onKeyDown={stop}>
        <Checkbox
          checked={false}
          label={label}
          aria-disabled
          aria-describedby={entry.reason ? reasonId : undefined}
          style={s.checkbox}
        />
        {entry.reason && (
          <span id={reasonId} style={s.reason}>
            {t(`reason.${entry.reason}`)}
          </span>
        )}
      </span>
    );
  }

  return (
    <span style={s.root} onClick={stop} onKeyDown={stop}>
      <Checkbox
        checked={checked}
        onChange={() => onToggle(entry.finding_id)}
        label={label}
        aria-disabled={disabled || undefined}
        style={s.checkbox}
      />
      {entry.anchor.kind === "general" && <span style={s.note}>{t("offDiff")}</span>}
    </span>
  );
}

export default FindingPublishControl;
