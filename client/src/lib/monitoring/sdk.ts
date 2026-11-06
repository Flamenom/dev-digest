/* monitoring/sdk.ts — the ONLY runtime importer of `@sentry/browser`, loaded via
   dynamic `import("./sdk")` from `sentry.ts` and only when a DSN is set.
   Named re-exports (instead of `import("@sentry/browser")` as a namespace) let
   the bundler tree-shake the lazy chunk down to what we use: no Replay, no
   tracing, no feedback, no connectivity-diagnostic code (which embeds a
   hard-coded `*.ingest.sentry.io` URL). */
export {
  init,
  captureException,
  setUser,
  globalHandlersIntegration,
  linkedErrorsIntegration,
  dedupeIntegration,
} from "@sentry/browser";
