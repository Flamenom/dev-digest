/* query-meta.ts — typed `meta` for React Query mutations.

   `errorChannel` decides who surfaces a failed mutation (one channel per
   mutation, never both):
   - "global" (default) — the global MutationCache toast in `providers.tsx`;
   - "local" — the caller shows it itself (an inline alert next to its form,
     or its own specific toast); the global toast is skipped. */

export type ErrorChannel = "global" | "local";

export interface AppMutationMeta extends Record<string, unknown> {
  errorChannel?: ErrorChannel;
}

declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: AppMutationMeta;
  }
}

/** Spread into `useMutation({...})`: `...errorChannelMeta("local")` when the caller renders the error itself. */
export function errorChannelMeta(channel: ErrorChannel): { meta: AppMutationMeta } {
  return { meta: { errorChannel: channel } };
}

/** Options for a mutation hook shared by callers with different error channels. */
export interface ErrorChannelOptions {
  /** Default "global" (the toast). */
  errorChannel?: ErrorChannel;
}

export function isLocalErrorChannel(meta: AppMutationMeta | undefined): boolean {
  return meta?.errorChannel === "local";
}
