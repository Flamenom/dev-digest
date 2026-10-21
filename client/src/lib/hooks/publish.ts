/* hooks/publish.ts — publish review findings to a GitLab MR as one batch review
   (spec 2026-10-21-gitlab-publish-findings, AC-2/AC-3/AC-21/AC-38/AC-39).
   Every API here is keyed by the review / publication row uuid. */
"use client";

import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { errorChannelMeta, type ErrorChannelOptions } from "../query-meta";
import type {
  OtherDraftsCount,
  Publication,
  PublishPreview,
  PublishRequestInput,
} from "../types";

/** AC-39: progress refreshed at most every 2 s while a publication runs. */
export const PUBLICATION_POLL_MS = 2000;

export const publishPreviewKey = (reviewId: string | null | undefined) =>
  ["publish-preview", reviewId] as const;
export const publishOtherDraftsKey = (reviewId: string | null | undefined) =>
  ["publish-other-drafts", reviewId] as const;
export const reviewPublicationsKey = (reviewId: string | null | undefined) =>
  ["review-publications", reviewId] as const;
export const publicationKey = (id: string | null | undefined) => ["publication", id] as const;

export interface PublishQueryOptions {
  /** Only true for GitLab repos — a GitHub PR makes no publish request (AC-3). */
  enabled?: boolean;
}

/** Per-finding publishability, anchors and review-level blockers. Makes no GitLab call (AC-2). */
export function usePublishPreview(
  reviewId: string | null | undefined,
  { enabled = true }: PublishQueryOptions = {},
) {
  return useQuery({
    queryKey: publishPreviewKey(reviewId),
    queryFn: () => api.get<PublishPreview>(`/reviews/${reviewId}/publish-preview`),
    enabled: enabled && !!reviewId,
  });
}

/** Auth failures keep the global handling (sign-in redirect / session re-read). */
function isAuthFailure(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

/**
 * The service account's other drafts on the MR (AC-38). One read-only GitLab
 * request, always fresh, never retried. A failure is an expected fallback
 * (the dialog's "couldn't check" warning), so it resolves to
 * `{ other_drafts: null }` instead of erroring — no global 5xx toast.
 */
export function useOtherDraftsCount(
  reviewId: string | null | undefined,
  { enabled = true }: PublishQueryOptions = {},
) {
  return useQuery({
    queryKey: publishOtherDraftsKey(reviewId),
    queryFn: async (): Promise<OtherDraftsCount> => {
      try {
        return await api.get<OtherDraftsCount>(`/reviews/${reviewId}/publish-other-drafts`);
      } catch (err) {
        if (isAuthFailure(err)) throw err;
        return { other_drafts: null };
      }
    },
    enabled: enabled && !!reviewId,
    staleTime: 0,
    retry: false,
  });
}

/** Refreshes what a finished publication changed: finding states and published links. */
function invalidateAfterTerminal(qc: QueryClient, publication: Publication): void {
  void qc.invalidateQueries({ queryKey: publishPreviewKey(publication.review_id) });
  void qc.invalidateQueries({ queryKey: reviewPublicationsKey(publication.review_id) });
  void qc.invalidateQueries({ queryKey: ["reviews", publication.pr_id] });
}

/**
 * Starts a publication (`202` + the in-progress publication, AC-21). The
 * caller (the confirm dialog) renders the failure itself — one error channel.
 */
export function useCreatePublication(
  reviewId: string | null | undefined,
  { errorChannel = "local" }: ErrorChannelOptions = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PublishRequestInput) =>
      api.post<Publication>(`/reviews/${reviewId}/publications`, input),
    ...errorChannelMeta(errorChannel),
    onSuccess: (publication) => {
      qc.setQueryData(publicationKey(publication.id), publication);
      void qc.invalidateQueries({ queryKey: reviewPublicationsKey(reviewId) });
    },
  });
}

/**
 * One publication's status. Polls every 2 s while `in_progress` (AC-39); when
 * it turns terminal the preview and the PR's reviews are invalidated so the
 * finding states and links refresh.
 */
export function usePublication(id: string | null | undefined) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: publicationKey(id),
    queryFn: async () => {
      const previous = qc.getQueryData<Publication>(publicationKey(id));
      const next = await api.get<Publication>(`/publications/${id}`);
      if (previous?.status === "in_progress" && next.status !== "in_progress") {
        invalidateAfterTerminal(qc, next);
      }
      return next;
    },
    enabled: !!id,
    refetchInterval: (query) =>
      query.state.data?.status === "in_progress" ? PUBLICATION_POLL_MS : false,
  });
}

/** A review's publications, newest first — used to resume progress after a reload (AC-39). */
export function useReviewPublications(
  reviewId: string | null | undefined,
  { enabled = true }: PublishQueryOptions = {},
) {
  return useQuery({
    queryKey: reviewPublicationsKey(reviewId),
    queryFn: () => api.get<Publication[]>(`/reviews/${reviewId}/publications`),
    enabled: enabled && !!reviewId,
  });
}

/** The newest in-progress publication of a newest-first list, or null. */
export function activePublication(
  publications: readonly Publication[] | null | undefined,
): Publication | null {
  return publications?.find((p) => p.status === "in_progress") ?? null;
}
