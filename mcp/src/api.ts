/* api.ts — the ONLY file in this package doing `fetch`. Modeled on
   client/src/lib/api.ts: JSON headers only when a body is sent, failures
   normalized into ApiError so errors.ts can map them to forward-leading
   tool errors. Everything above receives the DevDigestApi interface. */

import { API_BASE, FETCH_TIMEOUT_MS } from './config.js';

/** Normalized API failure. `status: 0` = network error (API down); `code: 'timeout'` = HTTP timeout. */
export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** The injected API seam: tools/resolvers/poll depend on this, never on fetch. */
export interface DevDigestApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

async function apiFetch<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        // Only declare a JSON body when one is actually sent — a body-less POST
        // with content-type json trips Fastify's empty-body check.
        ...(init?.body != null ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new ApiError(`Request to ${path} timed out after ${FETCH_TIMEOUT_MS}ms`, 0, 'timeout');
    }
    // Network failure / API down.
    throw new ApiError(`Cannot reach the DevDigest API at ${base}`, 0, 'network_error');
  }

  if (!res.ok) {
    let code: string | undefined;
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body?.error) {
        code = body.error.code;
        message = body.error.message ?? message;
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status, code);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Build the real HTTP-backed DevDigestApi (composition root only; tests inject a fake). */
export function createApi(base: string = API_BASE): DevDigestApi {
  return {
    get: <T>(path: string) => apiFetch<T>(base, path),
    post: <T>(path: string, body?: unknown) =>
      apiFetch<T>(base, path, {
        method: 'POST',
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
  };
}
