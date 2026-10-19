/* config.ts — the package's few knobs. All are plain constants so the rest of
   the code stays pure and injectable. */

/** Base URL of the DevDigest Fastify API (local by default). */
export const API_BASE = process.env.DEVDIGEST_API_BASE ?? 'http://localhost:3001';

/** Personal API token for a server-mode DevDigest (Settings → API tokens).
    Optional: unset/blank = local mode, no Authorization header is sent.
    Never log this value or put it in an error message. */
export const API_TOKEN: string | undefined = process.env.DEVDIGEST_API_TOKEN?.trim() || undefined;

/** Thrown for an unsafe/invalid MCP configuration. The message names the
    setting to fix — it never contains the token value. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Loopback = this machine; cleartext never leaves the host. */
function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * Refuse to send a bearer token where it would cross the network in cleartext:
 * with a token set, DEVDIGEST_API_BASE must be https://, or http:// to a
 * loopback host (localhost / 127.0.0.1 / ::1). Without a token nothing is
 * checked (local mode is unchanged). Pure — called by createApi at startup.
 */
export function assertTokenTransport(base: string, token: string | undefined): void {
  if (!token) return;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new ConfigError(
      'DEVDIGEST_API_BASE is not a valid URL; refusing to send DEVDIGEST_API_TOKEN.',
    );
  }
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return;
  throw new ConfigError(
    `DEVDIGEST_API_TOKEN is set but DEVDIGEST_API_BASE (${url.protocol}//${url.host}) is not https:// ` +
      'and not a loopback host — refusing to send the token in cleartext. ' +
      'Use https://<host>/api, or http://localhost / 127.0.0.1 / [::1] for a local API.',
  );
}

/** Run-status poll cadence — matches the web client (client/src/lib/hooks/reviews.ts). */
export const POLL_INTERVAL_MS = 4000;

/** Wait budget for a synchronous review run before returning status "timeout". */
export const RUN_TIMEOUT_MS = 120_000;

/** Per-request HTTP timeout for every API call. */
export const FETCH_TIMEOUT_MS = 15_000;
