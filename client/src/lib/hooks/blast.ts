/* hooks/blast.ts — React Query hook for the Blast Radius card (L04).
   Query key: ["pr-blast", prId] — one cache entry per PR holding BlastResponse
   (deterministic, no LLM; computed on read server-side from the repo-intel index).
     GET /pulls/:id/blast → BlastResponse */
"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { BlastResponse } from "@devdigest/shared";

export function usePrBlast(prId: string | null | undefined) {
  return useQuery({
    queryKey: ["pr-blast", prId],
    queryFn: () => api.get<BlastResponse>(`/pulls/${prId}/blast`),
    enabled: !!prId,
  });
}
