/* InlineComposer — shared inline comment composer (new comment or reply to a
   thread). Posts live to the host via the DiffCommentApi. On a read-only host
   (GitLab) the draft can still be written and copied, but posting is disabled
   and explained by a visible note (AC-43). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Textarea, Button } from "@devdigest/ui";
import { ReadOnlyPostNotice, useCopyToClipboard } from "@/components/read-only-host";
import { cs, type DiffCommentApi } from "../comments";

/** Read-only host: disabled post + Cancel + Copy + the visible note. Kept in its
 *  own component so a GitHub composer never resolves the `prHost` catalog. */
function ReadOnlyComposerActions({
  text,
  postLabel,
  children,
}: {
  text: string;
  postLabel: string;
  children: React.ReactNode;
}) {
  const t = useTranslations("prHost");
  const copy = useCopyToClipboard();
  return (
    <ReadOnlyPostNotice label={postLabel} kind="primary" noteStyle={cs.hint}>
      {children}
      <Button
        kind="secondary"
        size="sm"
        icon="Copy"
        disabled={!text.trim()}
        onClick={() => void copy(text.trim())}
      >
        {t("readOnly.copyComment")}
      </Button>
    </ReadOnlyPostNotice>
  );
}

export function InlineComposer({
  commenting,
  path,
  line,
  side,
  inReplyTo,
  onClose,
}: {
  commenting: DiffCommentApi;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  inReplyTo?: number;
  onClose: () => void;
}) {
  const t = useTranslations("shell");
  const readOnly = !!commenting.readOnly;
  const [text, setText] = React.useState("");
  const submit = async () => {
    const body = text.trim();
    if (!body || readOnly) return;
    try {
      await commenting.onSubmit({
        path,
        line,
        side,
        body,
        ...(inReplyTo != null ? { in_reply_to: inReplyTo } : {}),
      });
      setText("");
      onClose();
    } catch {
      /* error toast is raised by the caller; keep the draft open */
    }
  };
  const cancel = (
    <Button kind="ghost" size="sm" onClick={onClose} disabled={commenting.posting}>
      {t("diffViewer.cancel")}
    </Button>
  );
  return (
    <div
      style={cs.thread}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
      }}
    >
      <Textarea
        value={text}
        onChange={setText}
        rows={3}
        placeholder={t("diffViewer.commentPlaceholder")}
      />
      <div style={cs.composerActions}>
        {readOnly ? (
          <ReadOnlyComposerActions text={text} postLabel={t("diffViewer.post")}>
            {cancel}
          </ReadOnlyComposerActions>
        ) : (
          <>
            <Button
              kind="primary"
              size="sm"
              icon="MessageSquare"
              loading={commenting.posting}
              disabled={commenting.posting || !text.trim()}
              onClick={() => void submit()}
            >
              {t("diffViewer.post")}
            </Button>
            {cancel}
            <span style={cs.hint}>{t("diffViewer.postedToGitHub")}</span>
          </>
        )}
      </div>
    </div>
  );
}
