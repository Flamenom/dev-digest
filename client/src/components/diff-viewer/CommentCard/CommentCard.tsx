/* CommentCard — one host comment rendered as a Card with avatar + markdown
   body. Labelled with the host username; a GitLab note posted via DevDigest
   adds "via DevDigest · <name>" (AC-39). Used by CommentThreadView and
   OutdatedComments. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon, Card, Avatar, Markdown } from "@devdigest/ui";
import type { HostComment } from "@/lib/types";
import { cs, type CommentProvider } from "../comments";

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function CommentCard({ c, provider }: { c: HostComment; provider: CommentProvider }) {
  const t = useTranslations("prHost");
  const attributedTo = c.devdigest_attribution?.name;
  return (
    <Card>
      <div style={cs.headRow}>
        <Avatar name={c.user} size={20} />
        <span style={cs.user}>{c.user}</span>
        {/* Plain text — the attributed name is user-controlled, never HTML. */}
        {attributedTo && (
          <span style={cs.attribution}>{t("comments.attribution", { name: attributedTo })}</span>
        )}
        <span style={cs.time}>{formatWhen(c.created_at)}</span>
        <span style={{ flex: 1 }} />
        <a href={c.html_url} target="_blank" rel="noopener noreferrer" style={cs.ghLink}>
          <Icon.ExternalLink size={12} />
          {t("viewOn", { provider: c.provider ?? provider })}
        </a>
      </div>
      <div style={cs.mdBody}>
        <Markdown>{c.body}</Markdown>
      </div>
    </Card>
  );
}
