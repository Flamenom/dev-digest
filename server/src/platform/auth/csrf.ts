/**
 * CSRF check for cookie-authenticated mutations (AC-50, google mode only).
 *
 * A `POST` / `PUT` / `PATCH` / `DELETE` authenticated by the session cookie
 * must:
 *  1. carry an `Origin` header (or, when absent, a `Referer` whose origin is
 *     used) that EXACTLY equals the configured public web origin; and
 *  2. carry the application's custom header `x-devdigest-csrf` (any non-empty
 *     value — a cross-site form cannot set custom headers, and a cross-site
 *     `fetch` that sets one triggers a preflight our CORS policy refuses).
 *
 * Bearer-token requests are exempt (the guard only calls this for
 * `via: 'session'`). Pure: no Fastify, no I/O.
 */
import { CSRF_HEADER } from '@devdigest/shared';

export const CSRF_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type Headers = Readonly<Record<string, string | string[] | undefined>>;

function single(headers: Headers, name: string): string | undefined {
  const v = headers[name];
  return typeof v === 'string' ? v : undefined; // a repeated header is ambiguous → absent
}

/** The request's claimed origin: `Origin`, else the origin of `Referer`; undefined when neither parses. */
export function requestOrigin(headers: Headers): string | undefined {
  const origin = single(headers, 'origin');
  if (origin !== undefined) return origin.trim();
  const referer = single(headers, 'referer');
  if (referer === undefined) return undefined;
  try {
    const url = new URL(referer);
    return url.origin === 'null' ? undefined : url.origin;
  } catch {
    return undefined;
  }
}

/** True when a cookie-authenticated request with this method + headers passes the CSRF check. */
export function passesCsrf(method: string, headers: Headers, publicOrigin: string): boolean {
  if (!CSRF_METHODS.has(method.toUpperCase())) return true;
  const origin = requestOrigin(headers);
  if (origin === undefined || origin !== publicOrigin) return false;
  const marker = single(headers, CSRF_HEADER);
  return marker !== undefined && marker.trim().length > 0;
}
