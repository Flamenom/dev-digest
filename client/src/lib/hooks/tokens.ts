/* hooks/tokens.ts — Settings → API tokens (own personal tokens, google mode).
   GET /tokens lists the caller's tokens (never the value); POST /tokens returns
   the full value exactly once (`ApiTokenCreated.token`) — callers show it and
   drop it, it is never cached; DELETE /tokens/:id revokes. */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ApiTokenCreated,
  ApiTokenCreateInput,
  ApiTokenListItem,
} from "@devdigest/shared";
import { api } from "../api";

export const API_TOKENS_QUERY_KEY = ["api-tokens"] as const;

export function useApiTokens(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: API_TOKENS_QUERY_KEY,
    queryFn: () => api.get<ApiTokenListItem[]>("/tokens"),
    enabled: options.enabled ?? true,
  });
}

/** `expires_in_days` is optional on input (server default 90). */
export type CreateApiTokenInput = Pick<ApiTokenCreateInput, "name"> &
  Partial<Pick<ApiTokenCreateInput, "expires_in_days">>;

export function useCreateApiToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateApiTokenInput) => api.post<ApiTokenCreated>("/tokens", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: API_TOKENS_QUERY_KEY }),
  });
}

export function useRevokeApiToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) => api.del<unknown>(`/tokens/${encodeURIComponent(tokenId)}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: API_TOKENS_QUERY_KEY }),
  });
}
