/* config.ts — the package's few knobs. All are plain constants so the rest of
   the code stays pure and injectable. */

/** Base URL of the DevDigest Fastify API (local by default). */
export const API_BASE = process.env.DEVDIGEST_API_BASE ?? 'http://localhost:3001';

/** Run-status poll cadence — matches the web client (client/src/lib/hooks/reviews.ts). */
export const POLL_INTERVAL_MS = 4000;

/** Wait budget for a synchronous review run before returning status "timeout". */
export const RUN_TIMEOUT_MS = 120_000;

/** Per-request HTTP timeout for every API call. */
export const FETCH_TIMEOUT_MS = 15_000;
