/* hooks/conventions.ts — React Query hooks for the Conventions Extractor.
   Query key: ["conventions", repoId] — one cache entry per repo holding the
   full ConventionListResponse (candidates + scan stats).
     GET   /repos/:id/conventions          → ConventionListResponse
     POST  /repos/:id/conventions/extract  → synchronous scan (2 LLM calls)
     PATCH /conventions/:id                → status accept/reject and/or rule edit
     PATCH /repos/:id/conventions          → bulk status ("Deselect all") */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  Convention,
  ConventionExtractResponse,
  ConventionListResponse,
  ConventionStatus,
  UpdateConventionBody,
} from "@devdigest/shared";

export function useConventions(repoId: string | null | undefined) {
  return useQuery({
    queryKey: ["conventions", repoId],
    queryFn: () => api.get<ConventionListResponse>(`/repos/${repoId}/conventions`),
    enabled: !!repoId,
  });
}

/** Synchronous extraction — the mutation's isPending drives the "Scanning…" state. */
export function useExtractConventions(repoId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<ConventionExtractResponse>(`/repos/${repoId}/conventions/extract`),
    onSuccess: (data) => {
      qc.setQueryData<ConventionListResponse>(["conventions", repoId], data);
    },
  });
}

export interface UpdateConventionInput {
  id: string;
  patch: UpdateConventionBody;
}

/** Optimistic accept/reject/edit — the card state must flip instantly. */
export function useUpdateConvention(repoId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: UpdateConventionInput) =>
      api.patch<Convention>(`/conventions/${id}`, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ["conventions", repoId] });
      const prev = qc.getQueryData<ConventionListResponse>(["conventions", repoId]);
      if (prev) {
        qc.setQueryData<ConventionListResponse>(["conventions", repoId], {
          ...prev,
          conventions: prev.conventions.map((cv) => (cv.id === id ? { ...cv, ...patch } : cv)),
        });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["conventions", repoId], ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["conventions", repoId] });
    },
  });
}

/** Bulk status reset — powers "Deselect all" (status: 'pending'). */
export function useBulkConventionStatus(repoId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status: ConventionStatus) =>
      api.patch<{ updated: number }>(`/repos/${repoId}/conventions`, { status }),
    onMutate: async (status) => {
      await qc.cancelQueries({ queryKey: ["conventions", repoId] });
      const prev = qc.getQueryData<ConventionListResponse>(["conventions", repoId]);
      if (prev) {
        qc.setQueryData<ConventionListResponse>(["conventions", repoId], {
          ...prev,
          conventions: prev.conventions.map((cv) => ({ ...cv, status })),
        });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["conventions", repoId], ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["conventions", repoId] });
    },
  });
}
