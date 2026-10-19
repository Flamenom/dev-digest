/* InlineComposer — shared inline comment composer (new comment or reply to a
   thread). Posts live to the host via the DiffCommentApi. On a read-only host
   (GitLab) the draft can still be written and copied, but posting is disabled
   and explained by a visible note (AC-43). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Textarea, Button } from "@devdigest/ui";
import { notify } from "@/lib/toast";
import { cs, type DiffCommentApi } from "../comments";

/** Copy button + the visible note the disabled post button points at. */
function ReadOnlyExtras({ text, noteId }: { text: string; noteId: string }) {
  const t = useTranslations("prHost");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text.trim());
      notify.success(t("readOnly.copied"));
    } catch {
      notify.error(t("readOnly.copyFailed"));
    }
  };
  return (
    <>
      <Button kind="secondary" size="sm" icon="Copy" disabled={!text.trim()} onClick={() => void copy()}>
        {t("readOnly.copyComment")}
      </Button>
      <span id={noteId} style={cs.hint}>
        {t("readOnly.note")}
      </span>
    </>
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
  const noteId = React.useId();
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
        <Button
          kind="primary"
          size="sm"
          icon="MessageSquare"
          loading={!readOnly && commenting.posting}
          disabled={readOnly || commenting.posting || !text.trim()}
          aria-describedby={readOnly ? noteId : undefined}
          onClick={() => void submit()}
        >
          {t("diffViewer.post")}
        </Button>
        <Button kind="ghost" size="sm" onClick={onClose} disabled={commenting.posting}>
          {t("diffViewer.cancel")}
        </Button>
        {readOnly ? (
          <ReadOnlyExtras text={text} noteId={noteId} />
        ) : (
          <span style={cs.hint}>{t("diffViewer.postedToGitHub")}</span>
        )}
      </div>
    </div>
  );
}
