/* hooks/intent.ts — React Query hooks for the PR Intent Layer (L03).
   Query key: ["pr-intent", prId] — one cache entry per PR holding IntentDetail.
     GET  /pulls/:id/intent → IntentDetail (404 until first classification → empty state)
     POST /pulls/:id/intent → synchronous re/classification (one cheap LLM call) */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { IntentDetail } from "@devdigest/shared";

export function usePrIntent(prId: string | null | undefined) {
  return useQuery({
    queryKey: ["pr-intent", prId],
    queryFn: () => api.get<IntentDetail>(`/pulls/${prId}/intent`),
    enabled: !!prId,
  });
}

/** Synchronous classification — the mutation's isPending drives the loading state. */
export function useClassifyIntent(prId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<IntentDetail>(`/pulls/${prId}/intent`),
    onSuccess: (data) => {
      qc.setQueryData<IntentDetail>(["pr-intent", prId], data);
    },
  });
}
