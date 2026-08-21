"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { SectionLabel, Button, Skeleton, ErrorState } from "@devdigest/ui";
import { DiffViewer, type DiffCommentApi } from "@/components/diff-viewer";
import { usePrComments, useCreatePrComment } from "@/lib/hooks/reviews";
import { usePrSmartDiff } from "@/lib/hooks/smart-diff";
import { notify } from "@/lib/toast";
import type { PrFile, ReviewRecord } from "@devdigest/shared";
import { SmartDiffViewer } from "./_components/SmartDiffViewer";
import { styles as s } from "./styles";

type DiffMode = "smart" | "original";

interface DiffTabProps {
  prId: string | null;
  filesCount: number;
  files: PrFile[];
  /** Inline commenting is offered only on open PRs (GitHub rejects otherwise). */
  canComment?: boolean;
  /** The PR's reviews, already loaded by the page — Smart order's severity join
   *  source (no second fetch). */
  reviews?: ReviewRecord[];
  /** Navigate to a finding's card in the Findings tab (Smart order only). */
  onGoToFinding?: (findingId: string) => void;
}

export function DiffTab({ prId, filesCount, files, canComment, reviews, onGoToFinding }: DiffTabProps) {
  const t = useTranslations("prReview");
  // Smart order is the DEFAULT when the tab opens (user-confirmed decision).
  const [mode, setMode] = React.useState<DiffMode>("smart");
  const smart = usePrSmartDiff(prId, mode === "smart");

  const { data: comments } = usePrComments(prId);
  const create = useCreatePrComment(prId);
  // Comments start hidden so the diff is clean by default — toggle to reveal.
  const [showComments, setShowComments] = React.useState(false);

  const commentCount = comments?.length ?? 0;

  const commenting: DiffCommentApi = {
    comments: comments ?? [],
    canComment: !!canComment && !!prId,
    showComments,
    posting: create.isPending,
    onSubmit: async (input) => {
      try {
        const res = await create.mutateAsync(input);
        setShowComments(true); // a just-posted comment shouldn't stay hidden
        return res;
      } catch (err) {
        notify.error(err instanceof Error ? err.message : "Couldn't post the comment to GitHub.");
        throw err;
      }
    },
  };

  return (
    <section>
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

      {mode === "original" ? (
        // Original order: today's viewer untouched — commenting kept, NO finding overlays.
        <DiffViewer files={files} commenting={commenting} />
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
        />
      ) : null}
    </section>
  );
}
