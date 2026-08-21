/* hooks/smart-diff.ts — React Query hook for the Smart Diff view (L0x).
   Query key: ["pr-smart-diff", prId] — one cache entry per PR holding the
   computed SmartDiffResponse (deterministic, no LLM; computed on read server-side).
     GET /pulls/:id/smart-diff → SmartDiffResponse
   Gated by `enabled` so the payload is only fetched while Smart order is active. */
"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { SmartDiffResponse } from "@devdigest/shared";

export function usePrSmartDiff(prId: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["pr-smart-diff", prId],
    queryFn: () => api.get<SmartDiffResponse>(`/pulls/${prId}/smart-diff`),
    enabled: !!prId && enabled,
  });
}
