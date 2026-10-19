"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { SectionLabel, Button, Skeleton, ErrorState } from "@devdigest/ui";
import { DiffViewer, type DiffCommentApi } from "@/components/diff-viewer";
import { usePrComments, useCreatePrComment } from "@/lib/hooks/reviews";
import { usePrSmartDiff } from "@/lib/hooks/smart-diff";
import { notify } from "@/lib/toast";
import type { ReviewRecord } from "@devdigest/shared";
import type { PrFileHost } from "@/lib/types";
import type { HostLabelKey } from "@/lib/host-urls";
import { SmartDiffViewer } from "./_components/SmartDiffViewer";
import { styles as s } from "./styles";

type DiffMode = "smart" | "original";

interface DiffTabProps {
  prId: string | null;
  filesCount: number;
  files: PrFileHost[];
  /** Inline commenting is offered only on open PRs (GitHub rejects otherwise). */
  canComment?: boolean;
  /** The host does not accept posted comments (GitLab): the post control is
   *  disabled and explained, copying the text is the alternative (AC-43). */
  readOnly?: boolean;
  /** Names the host in the post-failure toast. Defaults to GitHub. */
  provider?: HostLabelKey;
  /** Files whose patch the host withheld — not reviewable (AC-31 UI). */
  filesOmittedByHost?: number;
  /** The PR's reviews, already loaded by the page — Smart order's severity join
   *  source (no second fetch). */
  reviews?: ReviewRecord[];
  /** Navigate to a finding's card in the Findings tab (Smart order only). */
  onGoToFinding?: (findingId: string) => void;
  /** Blast-card deep-link: scroll this file (and line, when in the patch) into
   *  view once after render, in either mode, then report consumption. */
  fileTarget?: { file: string; line?: number } | null;
  onFileTargetConsumed?: () => void;
}

/** Read-only host (GitLab): a disabled post control described by a VISIBLE
 *  note — keyboard/screen-reader reachable, never hover-only (AC-43). */
function ReadOnlyNotice() {
  const t = useTranslations("prHost");
  const noteId = React.useId();
  return (
    <div style={s.notice}>
      <Button kind="ghost" size="sm" icon="MessageSquare" disabled aria-describedby={noteId}>
        {t("readOnly.postComment")}
      </Button>
      <span id={noteId}>{t("readOnly.note")}</span>
    </div>
  );
}

/** Files whose patch the host withheld are not reviewed (AC-31 UI). */
function OmittedFilesNotice({ count }: { count: number }) {
  const t = useTranslations("prHost");
  return (
    <div style={s.notice} role="note">
      {t("files.omittedByHost", { count })}
    </div>
  );
}

export function DiffTab({
  prId,
  filesCount,
  files,
  canComment,
  readOnly = false,
  provider = "github",
  filesOmittedByHost = 0,
  reviews,
  onGoToFinding,
  fileTarget,
  onFileTargetConsumed,
}: DiffTabProps) {
  const t = useTranslations("prReview");
  // Root translator: the `prHost` key is only resolved on the (rare) failure
  // path, so GitHub-only callers never need that catalog.
  const tRoot = useTranslations();
  // Smart order is the DEFAULT when the tab opens (user-confirmed decision).
  const [mode, setMode] = React.useState<DiffMode>("smart");
  const smart = usePrSmartDiff(prId, mode === "smart");
  const containerRef = React.useRef<HTMLElement>(null);

  // One-shot scroll to the targeted FileCard (and its exact line when it is in
  // the rendered patch). Waits for the smart payload in Smart mode; the URL
  // params are cleared after the attempt so the jump never replays.
  const smartReady = mode !== "smart" || smart.data != null;
  React.useEffect(() => {
    if (!fileTarget || !smartReady) return;
    const root = containerRef.current;
    if (root) {
      const card = root.querySelector(`[data-file-path="${CSS.escape(fileTarget.file)}"]`);
      const lineEl =
        fileTarget.line != null && card
          ? card.querySelector(`[data-line-no="${fileTarget.line}"]`)
          : null;
      const el = lineEl ?? card;
      el?.scrollIntoView?.({ behavior: "smooth", block: lineEl ? "center" : "start" });
    }
    onFileTargetConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileTarget, smartReady]);

  const { data: comments } = usePrComments(prId);
  const create = useCreatePrComment(prId);
  // Comments start hidden so the diff is clean by default — toggle to reveal.
  const [showComments, setShowComments] = React.useState(false);

  const commentCount = comments?.length ?? 0;

  const commenting: DiffCommentApi = {
    comments: comments ?? [],
    canComment: !readOnly && !!canComment && !!prId,
    readOnly,
    showComments,
    posting: create.isPending,
    onSubmit: async (input) => {
      try {
        const res = await create.mutateAsync(input);
        setShowComments(true); // a just-posted comment shouldn't stay hidden
        return res;
      } catch (err) {
        notify.error(
          err instanceof Error ? err.message : tRoot("prHost.comments.postFailed", { provider }),
        );
        throw err;
      }
    },
  };

  return (
    <section ref={containerRef}>
      <SectionLabel
        icon="Code"
        right={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {mode === "original" && commentCount > 0 && (
              <Button
                kind="ghost"
                size="sm"
                icon={showComments ? "EyeOff" : "Eye"}
                onClick={() => setShowComments((v) => !v)}
              >
                {showComments ? "Hide comments" : "Show comments"} ({commentCount})
              </Button>
            )}
            <div style={s.segmented} role="group" aria-label={t("smartDiff.groupedByRole")}>
              <button
                type="button"
                style={s.segment(mode === "smart")}
                aria-pressed={mode === "smart"}
                onClick={() => setMode("smart")}
              >
                {t("smartDiff.orderSmart")}
              </button>
              <button
                type="button"
                style={s.segment(mode === "original")}
                aria-pressed={mode === "original"}
                onClick={() => setMode("original")}
              >
                {t("smartDiff.orderOriginal")}
              </button>
            </div>
          </div>
        }
      >
        Files changed · {filesCount} files
      </SectionLabel>

      {readOnly && <ReadOnlyNotice />}
      {filesOmittedByHost > 0 && <OmittedFilesNotice count={filesOmittedByHost} />}

      {mode === "original" ? (
        // Original order: today's viewer untouched — commenting kept, NO finding overlays.
        <DiffViewer files={files} commenting={commenting} expandedPath={fileTarget?.file ?? null} />
      ) : smart.isLoading ? (
        <Skeleton height={200} />
      ) : smart.isError ? (
        <ErrorState
          title="Couldn't load the smart diff"
          body="The engine returned an error for the smart-diff view."
          onRetry={() => smart.refetch()}
        />
      ) : smart.data ? (
        <SmartDiffViewer
          smartDiff={smart.data}
          files={files}
          reviews={reviews ?? []}
          onFindingClick={onGoToFinding}
          expandedPath={fileTarget?.file ?? null}
        />
      ) : null}
    </section>
  );
}
