/* permissions.ts — role/ownership helpers over the session probe (AC-30 UI
   half, AC-33). UX only: the server enforces every rule (deny by default);
   these just decide what to disable/hide so a Member is not offered actions
   that would 403.

   While the probe is in flight `isPending` is true and nothing is allowed
   (fail closed); local mode resolves to the seeded user as Admin, so every
   control ends up enabled exactly as before multi-user mode. */
"use client";

import type { ActorRef, AuthMode, Role } from "@devdigest/shared";
import { useSession } from "./hooks/session";

/** Anything carrying the run initiator (`RunSummaryWithActor`, `ReviewRecordWithActor`). */
export interface StartedByLike {
  started_by?: ActorRef;
}

/** Anything carrying the creator (`EvalCaseRecordWithActor`). */
export interface CreatedByLike {
  created_by?: ActorRef;
}

export interface Permissions {
  /** `null` until the session probe resolves (or when it failed). */
  mode: AuthMode | null;
  role: Role | null;
  userId: string | null;
  isAdmin: boolean;
  /** Session probe in flight — consumers may render controls inert without the hint. */
  isPending: boolean;
  /** Cancel run: Admin always; Member only on runs they started (null initiator → Admin only). */
  canCancelRun: (run: StartedByLike | null | undefined) => boolean;
  /** Edit/delete eval case: Admin always; Member only on cases they created. */
  canEditEvalCase: (evalCase: CreatedByLike | null | undefined) => boolean;
}

/** Pure ownership rule: the actor ref names `userId`. Null/absent actor → not owned. */
export function isOwnedBy(actor: ActorRef | undefined, userId: string | null): boolean {
  return userId != null && actor != null && actor.user_id === userId;
}

/** Pure builder (exported for tests and non-hook callers). */
export function buildPermissions(input: {
  mode: AuthMode | null;
  role: Role | null;
  userId: string | null;
  isPending: boolean;
}): Permissions {
  const { mode, role, userId, isPending } = input;
  const isAdmin = role === "admin";
  return {
    mode,
    role,
    userId,
    isAdmin,
    isPending,
    canCancelRun: (run) => isAdmin || isOwnedBy(run?.started_by, userId),
    canEditEvalCase: (evalCase) => isAdmin || isOwnedBy(evalCase?.created_by, userId),
  };
}

export function useCan(): Permissions {
  const { data, isPending } = useSession();
  return buildPermissions({
    mode: data?.mode ?? null,
    role: data?.user.role ?? null,
    userId: data?.user.id ?? null,
    isPending,
  });
}

/** Shorthand for the common "is the current user an Admin" check. */
export function useIsAdmin(): boolean {
  return useCan().isAdmin;
}
