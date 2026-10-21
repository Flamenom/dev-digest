/* ReviewPublishSection — the GitLab publish flow of ONE review run (spec
   2026-10-21-gitlab-publish-findings, AC-36 – AC-40). Container: owns the
   preview / publications / publication queries, the in-memory selection, the
   confirm dialog and the progress view, and the Re-run wiring.

   The per-finding checkboxes live inside the run's FindingCards: this section
   wraps its body (`children`) in a `FindingPublishProvider`, read by each
   card's `FindingPublishAddon`. Until the preview loads — or when the viewer
   may not publish (AC-40) — there is no provider and the body renders exactly
   as before. */
"use client";

import React, { useState } from "react";
import type { ReviewRecordWithActor } from "@devdigest/shared";
import { hostPrUrl } from "@/lib/host-urls";
import { useRunReview } from "@/lib/hooks/reviews";
import {
  activePublication,
  usePublication,
  usePublishPreview,
  useReviewPublications,
} from "@/lib/hooks/publish";
import type { Publication } from "@/lib/types";
import { useFindingHost } from "../../../FindingCard";
import {
  FindingPublishProvider,
  PublishBlockerNotice,
  PublishConfirmDialog,
  PublishProgress,
  PublishToolbar,
  primaryBlocker,
  publishBlockerNoticeId,
  selectedFindings,
  usePublishSelection,
} from "../../../PublishFindings";
import { s } from "./styles";

export interface ReviewPublishSectionProps {
  review: ReviewRecordWithActor;
  prId: string;
  /** The run's body; its cards' `FindingPublishAddon`s read the publish state provided here. */
  children: React.ReactNode;
}

export function ReviewPublishSection({ review, prId, children }: ReviewPublishSectionProps) {
  const host = useFindingHost();
  const preview = usePublishPreview(review.id);
  const publications = useReviewPublications(review.id);
  const rerun = useRunReview();
  const sel = usePublishSelection(preview.data?.findings);
  const [dialogOpen, setDialogOpen] = useState(false);
  // The publication this section shows. A reload resumes the review's running
  // publication from server state (AC-39); it is pinned here (state adjusted
  // during render, no effect) so its result stays visible once it settles.
  const [trackedId, setTrackedId] = useState<string | null>(null);
  const resumable = activePublication(publications.data);
  if (trackedId === null && resumable) setTrackedId(resumable.id);
  const tracked = usePublication(trackedId);

  const data = preview.data;
  if (!data || !data.viewer_can_publish) return <>{children}</>;

  const publication = tracked.data ?? null;
  const running = publication?.status === "in_progress";
  const blocker = primaryBlocker(data.blockers);
  // The running publication's own "in progress" blocker is already told by the progress view.
  const showBlocker =
    !!blocker && !(blocker.code === "publish_in_progress" && running && blocker.publication_id === publication?.id);
  const busy = running || blocker?.code === "publish_in_progress";
  const noticeId = publishBlockerNoticeId(review.id);
  const entries = new Map(data.findings.map((e) => [e.finding_id, e]));
  const titleById = new Map(review.findings.map((f) => [f.id, f.title]));
  const mrUrl = host?.repo && data.mr_iid != null ? hostPrUrl(host.repo, data.mr_iid) : null;
  const onRerun = () => rerun.mutate({ prId, agentId: review.agent_id ?? undefined });

  const openDialog = () => {
    if (publication && !running) setTrackedId(null);
    setDialogOpen(true);
  };
  // The selection is kept: published findings drop out of it by derivation,
  // failed ones stay selected for "Try again".
  const onPublished = (p: Publication) => {
    setDialogOpen(false);
    setTrackedId(p.id);
  };

  return (
    <>
      <div style={s.section}>
        {publication && (
          <PublishProgress
            publication={publication}
            mrUrl={mrUrl}
            findingTitle={(id) => titleById.get(id)}
            onTryAgain={openDialog}
          />
        )}
        {showBlocker && blocker && (
          <PublishBlockerNotice id={noticeId} blocker={blocker} onRerun={onRerun} rerunPending={rerun.isPending} />
        )}
        <PublishToolbar
          state={sel.state}
          count={sel.count}
          publishableCount={sel.publishableCount}
          onToggleAll={sel.toggleAll}
          onPublish={openDialog}
          blockerNoticeId={showBlocker ? noticeId : null}
          busy={busy}
        />
      </div>
      <FindingPublishProvider
        value={{ entries, isSelected: sel.isSelected, onToggle: sel.toggle, disabled: busy }}
      >
        {children}
      </FindingPublishProvider>
      {dialogOpen && (
        <PublishConfirmDialog
          reviewId={review.id}
          mrIid={data.mr_iid}
          selected={selectedFindings(data.findings, sel.selected, review.findings)}
          onClose={() => setDialogOpen(false)}
          onPublished={onPublished}
          onRerun={onRerun}
        />
      )}
    </>
  );
}

export default ReviewPublishSection;
