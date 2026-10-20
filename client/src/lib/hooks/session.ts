/* hooks/session.ts — the current session probe (AC-32) and sign-out.

   `GET /auth/session` returns the session in BOTH modes (local mode answers
   with the seeded system user as Admin) and 401 `unauthenticated` when signed
   out in google mode. It is read ONCE per page load (`staleTime: Infinity`)
   and re-read only on explicit invalidation — a 403 authz error (AC-34) or a
   role change on the Members screen. Role/permission helpers live in
   `hooks/permissions.ts` (`useCan`). */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CurrentSession, SignOutResult } from "@devdigest/shared";
import { api, ApiError } from "../api";
import { goToSignIn } from "../sign-in-redirect";

export const SESSION_QUERY_KEY = ["session"] as const;

/** A 401 means "signed out" — retrying cannot fix it; other 4xx neither. */
function retryProbe(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

export function useSession() {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: () => api.get<CurrentSession>("/auth/session"),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: retryProbe,
  });
}

/** True when the probe failed because nobody is signed in (google mode). */
export function isUnauthenticated(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401 && err.code === "unauthenticated";
}

/**
 * POST /auth/sign-out, then leave for the sign-in screen with a full-page
 * navigation (drops every cached query of the signed-out user). Callers only
 * `mutate()`; they must not navigate themselves.
 */
export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<SignOutResult>("/auth/sign-out"),
    onSuccess: () => {
      qc.clear();
      goToSignIn();
    },
  });
}
