/* InlineComposer — shared inline comment composer (new comment or reply to a
   thread). Posts live to the PR's host (GitHub or GitLab) via the
   DiffCommentApi. A failed post keeps the composer open with the draft, shows
   the reason in an inline `role="alert"` region and offers "Copy text" (AC-32);
   the post button is disabled for a blank body, while a post is in flight and
   while posting is blocked by the host token (AC-14, AC-36, AC-25). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Textarea, Button } from "@devdigest/ui";
import { useCopyToClipboard } from "@/lib/hooks/clipboard";
import type { HostCommentReplyTarget } from "@/lib/types";
import { cs, type DiffCommentApi } from "../comments";

/** The reply field for this host: GitLab replies by discussion, GitHub by root id. */
function replyTarget(
  commenting: DiffCommentApi,
  inReplyTo: number | undefined,
  discussionId: string | null | undefined,
): HostCommentReplyTarget {
  if (commenting.provider === "gitlab" && discussionId) return { discussion_id: discussionId };
  return inReplyTo != null ? { in_reply_to: inReplyTo } : {};
}

export function InlineComposer({
  commenting,
  path,
  line,
  side,
  inReplyTo,
  discussionId,
  onClose,
}: {
  commenting: DiffCommentApi;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  /** Reply on GitHub: the thread's root comment id. */
  inReplyTo?: number;
  /** Reply on GitLab: the thread's discussion id. */
  discussionId?: string | null;
  onClose: () => void;
}) {
  const t = useTranslations("shell");
  const tHost = useTranslations("prHost");
  const copy = useCopyToClipboard();
  const { provider, postBlocked } = commenting;
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  // Local in-flight guard: the mutation's `isPending` only flips after a
  // re-render, so two rapid clicks must be stopped synchronously (AC-36).
  const inFlight = React.useRef(false);
  const [submitting, setSubmitting] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);

  const busy = submitting || commenting.posting;
  const canPost = !!text.trim() && !busy && !postBlocked;

  const submit = async () => {
    const body = text.trim();
    if (!body || postBlocked || inFlight.current || commenting.posting) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await commenting.onSubmit({
        path,
        line,
        side,
        body,
        ...replyTarget(commenting, inReplyTo, discussionId),
      });
      setText("");
      onClose();
    } catch (err) {
      // Keep the draft; explain inline and keep the cursor in the textarea.
      setError(
        err instanceof Error && err.message
          ? err.message
          : tHost("comments.postFailed", { provider }),
      );
      wrapRef.current?.querySelector("textarea")?.focus();
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div
      ref={wrapRef}
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
          loading={busy}
          disabled={!canPost}
          aria-describedby={postBlocked?.describedById}
          onClick={() => void submit()}
        >
          {t("diffViewer.post")}
        </Button>
        <Button kind="ghost" size="sm" onClick={onClose} disabled={busy}>
          {t("diffViewer.cancel")}
        </Button>
        {error != null && (
          <Button
            kind="secondary"
            size="sm"
            icon="Copy"
            disabled={!text.trim()}
            onClick={() => void copy(text.trim())}
          >
            {tHost("comments.copyText")}
          </Button>
        )}
        <span style={cs.hint}>{tHost("comments.postsTo", { provider })}</span>
      </div>
      {error != null && (
        <div role="alert" style={cs.postError}>
          {error}
        </div>
      )}
    </div>
  );
}
