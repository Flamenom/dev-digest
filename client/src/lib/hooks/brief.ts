/* hooks/brief.ts — React Query hooks for the PR "Why / Risk" Brief.
   Query key: ["pr-brief", prId] — one cache entry per PR holding PrBriefDetail.
     GET  /pulls/:id/brief → PrBriefDetail (always 200; `generation.state` tells the
                             card whether to render content or an inline empty state)
     POST /pulls/:id/brief → synchronous re/generation (one structured LLM call) */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { PrBriefDetail } from "@devdigest/shared";

export function usePrBrief(prId: string | null | undefined) {
  return useQuery({
    queryKey: ["pr-brief", prId],
    queryFn: () => api.get<PrBriefDetail>(`/pulls/${prId}/brief`),
    enabled: !!prId,
  });
}

/** Synchronous regeneration — the mutation's isPending drives the loading state. */
export function useRegenerateBrief(prId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<PrBriefDetail>(`/pulls/${prId}/brief`),
    onSuccess: (data) => {
      qc.setQueryData<PrBriefDetail>(["pr-brief", prId], data);
    },
  });
}
