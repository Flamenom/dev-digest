/* hooks/pr-sync.ts — PR-list sync orchestration for the Pull Requests page.
   The server emits a single `done` event on `GET /repos/:id/pulls/sync/events`
   and closes. A raw EventSource AUTO-RECONNECTS when the server closes the
   stream, which would silently turn this into periodic polling (AC-63) — so we
   `close()` on `done` AND on `error`, and never retry. Each list read that
   reports an in-flight sync (and each manual Refresh) gets exactly ONE one-shot
   listener, keyed by that read / click — never a timer, never a reconnect.
   Like `useRunEvents`, this bypasses api.ts + Query (EventSource is not a fetch). */
"use client";

import React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_BASE } from "../api";
import type { PrListSync } from "../types";
import { usePullsPage, useRefreshRepo, useSyncPulls } from "./core";

export type PrSyncOutcome = "done" | "error";

/**
 * Whether a list read started or joined a sync that has not finished yet — the
 * page then listens for its completion (AC-59). `fresh` means no sync was
 * started, so nothing to wait for (AC-61/63).
 */
export function isSyncInFlight(sync: PrListSync | undefined): boolean {
  return sync != null && (sync.trigger === "started" || sync.trigger === "joined");
}

/**
 * Open ONE one-shot completion listener per distinct `listenKey` (null = not
 * listening). On `done` or `error`: close the stream (never reconnect),
 * invalidate `["pulls", repoId]` exactly once so the list re-reads in place,
 * then report the outcome via `onSettled`. A new listener opens only when the
 * caller hands a NEW key (a newer in-flight read, or a new manual Refresh).
 */
export function usePrSyncCompletion(
  repoId: string | null | undefined,
  listenKey: string | null,
  onSettled?: (outcome: PrSyncOutcome) => void,
): void {
  const qc = useQueryClient();
  // Latest-callback ref: the subscription is tied to the key, not to the
  // callback's identity (which changes every render).
  const onSettledRef = React.useRef(onSettled);
  React.useEffect(() => {
    onSettledRef.current = onSettled;
  });

  React.useEffect(() => {
    if (!repoId || listenKey == null) return;
    const es = new EventSource(`${API_BASE}/repos/${repoId}/pulls/sync/events`, {
      withCredentials: true, // session cookie (AC-54); SSE is GET-only, no CSRF header
    });
    let settled = false;

    // Single settle path for `done` and `error`: close, invalidate once, report.
    const settle = (outcome: PrSyncOutcome) => {
      es.close();
      if (settled) return;
      settled = true;
      onSettledRef.current?.(outcome);
      void qc.invalidateQueries({ queryKey: ["pulls", repoId] });
    };
    const onDone = () => settle("done");
    es.addEventListener("done", onDone);
    es.onerror = () => settle("error");

    return () => {
      es.removeEventListener("done", onDone);
      es.close();
    };
  }, [qc, repoId, listenKey]);
}

interface SyncTracking {
  /** Token of a manual Refresh whose sync has not signalled completion yet. */
  manualToken: number | null;
  /** `dataUpdatedAt` of the newest read already covered by a settled listener. */
  settledReadAt: number;
  /** After an SSE `error`, reads stop opening listeners until a manual Refresh
   *  — otherwise error → refetch → still-running → listen → error would loop. */
  suspended: boolean;
}

type SyncAction =
  | { type: "manual"; token: number }
  | { type: "manualFailed" }
  | { type: "settled"; readAt: number; outcome: PrSyncOutcome };

function syncReducer(state: SyncTracking, action: SyncAction): SyncTracking {
  switch (action.type) {
    case "manual":
      return { ...state, manualToken: action.token, suspended: false };
    case "manualFailed":
      return { ...state, manualToken: null };
    case "settled":
      return {
        manualToken: null,
        settledReadAt: Math.max(state.settledReadAt, action.readAt),
        suspended: action.outcome === "error",
      };
  }
}

const INITIAL_TRACKING: SyncTracking = { manualToken: null, settledReadAt: 0, suspended: false };

/**
 * Everything the Pull Requests page needs about its list + sync:
 * - the list page query (`GET /repos/:id/pulls/page`, AC-55),
 * - one one-shot completion listener per in-flight read / manual Refresh,
 * - `updating` — the "Updating…" indicator (AC-59), cleared by the completion
 *   signal itself (not by an unrelated refetch landing),
 * - `onRefresh` — ONE click = `POST /pulls/sync` (start/join, AC-58) + the
 *   existing clone refresh `POST /repos/:id/refresh` (Q4).
 * No timers, no focus refetch, no reconnect (AC-63).
 */
export function usePullsSync(repoId: string) {
  const query = usePullsPage(repoId);
  const { data: page, dataUpdatedAt } = query;
  const sync = page?.sync;
  const refresh = useRefreshRepo();
  const syncPulls = useSyncPulls();
  const [tracking, dispatch] = React.useReducer(syncReducer, INITIAL_TRACKING);
  const tokenRef = React.useRef(0);
  // Set synchronously on click: the mutation's own `isPending` lands via a
  // batched notify, so two clicks in one tick would both see it false.
  const startingRef = React.useRef(false);

  const readPending =
    !tracking.suspended && isSyncInFlight(sync) && dataUpdatedAt > tracking.settledReadAt;
  const listenKey =
    tracking.manualToken != null
      ? `manual:${tracking.manualToken}`
      : readPending
        ? `read:${dataUpdatedAt}`
        : null;

  usePrSyncCompletion(repoId, listenKey, (outcome) =>
    dispatch({ type: "settled", readAt: dataUpdatedAt, outcome }),
  );

  // A manual sync is in flight from the click until its completion signal:
  // the POST is pending, or its one-shot listener has not settled yet.
  const manualPending = syncPulls.isPending || tracking.manualToken != null;

  const onRefresh = () => {
    // Re-clicks while a manual sync is awaited would POST again and churn the
    // listener — the button is disabled then, and this guards double-fires.
    if (manualPending || startingRef.current) return;
    startingRef.current = true;
    syncPulls.mutate(repoId, {
      onSuccess: () => {
        tokenRef.current += 1;
        dispatch({ type: "manual", token: tokenRef.current });
      },
      // Nothing to listen for; drop any manual pending so Refresh is usable again.
      onError: () => dispatch({ type: "manualFailed" }),
      onSettled: () => {
        startingRef.current = false;
      },
    });
    refresh.mutate(repoId);
  };

  return {
    pulls: page?.pulls,
    sync,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    // A cached `running` only counts for a read newer than the last settled
    // listener: after a settle (done → its one refetch failed, or SSE error →
    // suspended) nothing listens, so it would never clear. Show the
    // last-synced time instead; a manual Refresh resumes.
    updating:
      listenKey != null ||
      (sync?.state === "running" &&
        !tracking.suspended &&
        dataUpdatedAt > tracking.settledReadAt),
    refreshing: refresh.isPending || manualPending,
    /** The manual `POST /pulls/sync` failed to start (cleared on the next click). */
    syncError: syncPulls.error,
    onRefresh,
  };
}
