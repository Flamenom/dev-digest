/* hooks/members.ts — Settings → Members (GET /members, PATCH /members/:userId).
   Everyone can list; only Admins may update (server-enforced; the UI renders
   the controls aria-disabled for Members, AC-21/AC-33). */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Member, MemberList, MemberUpdate } from "@devdigest/shared";
import { api } from "../api";
import { errorChannelMeta } from "../query-meta";
import { SESSION_QUERY_KEY } from "./session";

export const MEMBERS_QUERY_KEY = ["members"] as const;

export function useMembers() {
  return useQuery({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: () => api.get<MemberList>("/members"),
  });
}

export interface UpdateMemberInput {
  userId: string;
  patch: MemberUpdate;
}

export function useUpdateMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, patch }: UpdateMemberInput) =>
      api.patch<Member>(`/members/${encodeURIComponent(userId)}`, patch),
    // MemberRow shows the failure (e.g. `last_admin`) inline in its row.
    ...errorChannelMeta("local"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
      // An Admin may have changed their OWN role — re-read the gating.
      void qc.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    },
  });
}
