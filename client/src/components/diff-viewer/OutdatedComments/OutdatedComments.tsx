/* OutdatedComments — footer list for comments the host can no longer place on
   the current diff (the anchored line is gone, or it predates the current head). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { type CommentProvider, type CommentThread, cs } from "../comments";
import { CommentCard } from "../CommentCard";

export function OutdatedComments({
  threads,
  provider,
}: {
  threads: CommentThread[];
  provider: CommentProvider;
}) {
  const t = useTranslations("shell");
  if (threads.length === 0) return null;
  const count = threads.reduce((n, th) => n + th.comments.length, 0);
  return (
    <div style={cs.outdatedWrap}>
      <span style={cs.outdatedTitle}>{t("diffViewer.outdatedTitle", { count })}</span>
      {threads.flatMap((th) => th.comments.map((c) => <CommentCard key={c.id} c={c} provider={provider} />))}
    </div>
  );
}
