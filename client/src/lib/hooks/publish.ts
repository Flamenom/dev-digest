/* hooks/publish.ts — publish review findings to a GitLab MR as one batch review
   (spec 2026-10-21-gitlab-publish-findings, AC-2/AC-3/AC-21/AC-38/AC-39),
   extended for outdated ("deprecated") runs (spec
   2026-10-23-gitlab-publish-outdated-findings, AC-19 – AC-24).
   Every API here is keyed by the review / publication row uuid. */
"use client";

import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { errorChannelMeta, type ErrorChannelOptions } from "../query-meta";
import type {
  OtherDraftsCount,
  Publication,
  PublicationWithDeprecation,
  PublishAcknowledgementInput,
  PublishPlan,
  PublishPreviewWithDeprecation,
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

/** Ids sorted + comma-joined: one cache entry per selection, whatever the click order. */
function planIdsParam(ids: readonly string[]): string {
  return [...ids].sort().join(",");
}

/**
 * The publish-plan key. Without `ids` it is the per-review PREFIX (used to
 * invalidate every selection's plan, AC-23).
 */
export const publishPlanKey = (reviewId: string | null | undefined, ids?: readonly string[]) =>
  ids === undefined
    ? (["publish-plan", reviewId] as const)
    : (["publish-plan", reviewId, planIdsParam(ids)] as const);

/** The publish's "deprecated run not acknowledged" codes (AC-4, AC-23). */
export const DEPRECATION_409_CODES: ReadonlySet<string> = new Set([
  "review_diff_outdated",
  "review_head_unknown",
]);

/** True for a `409` whose code says the run must be confirmed as deprecated (AC-23). */
export function isDeprecation409(err: unknown): boolean {
  return (
    err instanceof ApiError && err.status === 409 && !!err.code && DEPRECATION_409_CODES.has(err.code)
  );
}

/** The plan read's fallback: unknown drafts and placement, no global toast (AC-21, AC-22). */
export const PUBLISH_PLAN_UNAVAILABLE: PublishPlan = {
  other_drafts: null,
  plan_available: false,
  placement: null,
};

export interface PublishQueryOptions {
  /** Only true for GitLab repos — a GitHub PR makes no publish request (AC-3). */
  enabled?: boolean;
}

/**
 * Per-finding publishability, anchors, review-level blockers and the
 * review-level `deprecation` (AC-1, AC-19). Makes no GitLab call (AC-2).
 */
export function usePublishPreview(
  reviewId: string | null | undefined,
  { enabled = true }: PublishQueryOptions = {},
) {
  return useQuery({
    queryKey: publishPreviewKey(reviewId),
    queryFn: () => api.get<PublishPreviewWithDeprecation>(`/reviews/${reviewId}/publish-preview`),
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

/**
 * The read-only publish plan of the confirm dialog (AC-21): the live
 * deprecation, the positioned / general split of the selected findings and
 * the other-drafts count. Always fresh, never retried. A non-auth failure is
 * an expected fallback (the dialog's "couldn't check" line), so it resolves
 * to `PUBLISH_PLAN_UNAVAILABLE` instead of erroring — no global 5xx toast.
 */
export function usePublishPlan(
  reviewId: string | null | undefined,
  findingIds: readonly string[],
  { enabled = true }: PublishQueryOptions = {},
) {
  return useQuery({
    queryKey: publishPlanKey(reviewId, findingIds),
    queryFn: async (): Promise<PublishPlan> => {
      const query = new URLSearchParams({ finding_ids: planIdsParam(findingIds) });
      try {
        return await api.get<PublishPlan>(`/reviews/${reviewId}/publish-plan?${query.toString()}`);
      } catch (err) {
        if (isAuthFailure(err)) throw err;
        return PUBLISH_PLAN_UNAVAILABLE;
      }
    },
    enabled: enabled && !!reviewId && findingIds.length > 0,
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
 * A `409 review_diff_outdated | review_head_unknown` (deprecated run not
 * acknowledged, AC-4) refreshes the preview and every plan of the review so
 * the dialog can show the outdated warning; it is never retried — the user
 * confirms again (AC-23).
 */
export function useCreatePublication(
  reviewId: string | null | undefined,
  { errorChannel = "local" }: ErrorChannelOptions = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PublishRequestInput & PublishAcknowledgementInput) =>
      api.post<PublicationWithDeprecation>(`/reviews/${reviewId}/publications`, input),
    ...errorChannelMeta(errorChannel),
    retry: false,
    onError: (err) => {
      if (!isDeprecation409(err)) return;
      void qc.invalidateQueries({ queryKey: publishPreviewKey(reviewId) });
      void qc.invalidateQueries({ queryKey: publishPlanKey(reviewId) });
    },
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
      const previous = qc.getQueryData<PublicationWithDeprecation>(publicationKey(id));
      const next = await api.get<PublicationWithDeprecation>(`/publications/${id}`);
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
    queryFn: () => api.get<PublicationWithDeprecation[]>(`/reviews/${reviewId}/publications`),
    enabled: enabled && !!reviewId,
  });
}

/** The newest in-progress publication of a newest-first list, or null. */
export function activePublication<P extends Publication>(
  publications: readonly P[] | null | undefined,
): P | null {
  return publications?.find((p) => p.status === "in_progress") ?? null;
}
