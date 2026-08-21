/* use-query-param.ts — URL search params as state (react-best-practices:
   URL-dependent state like filters/sort/tabs belongs in the URL, not useState —
   it survives reload and makes the view shareable). One hook so every page
   stops hand-rolling its own URLSearchParams + router.replace dance. */
"use client";

import React from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * Read/write one URL search param. Absent (or explicitly cleared) reads as
 * `defaultValue`; setting `null` or `""` removes the key from the URL.
 * Uses router.replace (no history spam) without scrolling to top.
 */
export function useQueryParam(
  key: string,
  defaultValue = "",
): [string, (value: string | null) => void] {
  const search = useSearchParams();
  const router = useRouter();

  const value = search.get(key) ?? defaultValue;

  const set = React.useCallback(
    (next: string | null) => {
      // Build from the LIVE URL at call time, never from the `search` snapshot
      // captured when this callback was created — a debounced call fires after
      // the snapshot may have gone stale (e.g. ?status changed while ?q was
      // still debouncing), and rebuilding from the snapshot would silently
      // revert that concurrent change.
      // Known limitation: two DIFFERENT-key setters fired in the same tick
      // both read the same pre-navigation location (router.replace commits
      // async), so the first write loses. No current caller does that; if one
      // appears, batch the writes into a single setter instead.
      const sp = new URLSearchParams(window.location.search);
      if (next == null || next === "") sp.delete(key);
      else sp.set(key, next);
      const qs = sp.toString();
      router.replace(
        `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`,
        { scroll: false },
      );
    },
    [router, key],
  );

  return [value, set];
}

/**
 * Batched multi-key URL writer — the remedy for the same-tick limitation
 * documented in `useQueryParam` above: two different-key setters fired in one
 * tick both read the same pre-navigation location, so the first write loses.
 * This builds ONE URLSearchParams from the live URL, applies every update, and
 * commits ONE router.replace. `null`/`""` removes the key.
 */
export function useSetQueryParams(): (updates: Record<string, string | null>) => void {
  const router = useRouter();

  return React.useCallback(
    (updates: Record<string, string | null>) => {
      const sp = new URLSearchParams(window.location.search);
      for (const [key, next] of Object.entries(updates)) {
        if (next == null || next === "") sp.delete(key);
        else sp.set(key, next);
      }
      const qs = sp.toString();
      router.replace(
        `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`,
        { scroll: false },
      );
    },
    [router],
  );
}

/**
 * useQueryParam for TEXT INPUTS. A controlled input backed directly by the
 * (async-updating) URL drops keystrokes under fast typing, so this variant
 * echoes changes into local state immediately and syncs the URL debounced.
 */
export function useDebouncedQueryParam(
  key: string,
  defaultValue = "",
  delayMs = 250,
): [string, (value: string) => void] {
  const [urlValue, setUrlValue] = useQueryParam(key, defaultValue);
  const [local, setLocal] = React.useState(urlValue);
  // window.setTimeout: this is a browser-only module, but tsconfig includes
  // node types, so a bare `setTimeout` would type the id as NodeJS.Timeout.
  const timer = React.useRef<number | null>(null);

  const set = React.useCallback(
    (v: string) => {
      setLocal(v);
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setUrlValue(v);
      }, delayMs);
    },
    [setUrlValue, delayMs],
  );

  // The URL is the source of truth; `local` exists only to keep fast typing
  // responsive. When the URL changes underneath us (back/forward navigation,
  // another writer clearing the key) and no debounce is pending, reconcile the
  // mirror — otherwise the input would show a stale value forever.
  React.useEffect(() => {
    if (timer.current == null) setLocal(urlValue);
  }, [urlValue]);

  // Clear a pending sync on unmount (don't navigate after leaving the page).
  React.useEffect(() => {
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    };
  }, []);

  return [local, set];
}
