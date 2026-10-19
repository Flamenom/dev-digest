import { ExternalServiceError } from '../../platform/errors.js';
import { redactSecret } from '../../platform/redact.js';

/**
 * Minimal gitlab.com HTTP transport (REST v4 + GraphQL) over `fetch`.
 *
 * Resilience policy (spec NFR "Rate limiting / resilience") — deliberately NOT
 * `platform/resilience.withRetry` (its 250 ms base / 8 s cap does not match):
 *  - per-attempt timeout 15 s (`AbortSignal.timeout`);
 *  - retry only 429 / 5xx, at most 3 times, backoff 1 s / 2 s / 4 s ± 20 % jitter;
 *  - `Retry-After` (seconds or HTTP-date) honoured, capped at 30 s;
 *  - total extra wait per call ≤ 60 s.
 *
 * Security:
 *  - the origin is fixed to https://gitlab.com (no configurable base ⇒ no SSRF);
 *  - `redirect: 'manual'` — ANY 3xx is an error, never followed (a redirect to
 *    another host must not receive the token);
 *  - the token header is sent only when a token exists;
 *  - every error message passes through `redactSecret` with the token.
 */

export const GITLAB_ORIGIN = 'https://gitlab.com';
const REST_PREFIX = '/api/v4';
const GRAPHQL_PATH = '/api/graphql';

export const GITLAB_TIMEOUT_MS = 15_000;
export const GITLAB_MAX_RETRIES = 3;
export const GITLAB_BACKOFF_MS = [1_000, 2_000, 4_000] as const;
export const GITLAB_JITTER = 0.2;
export const GITLAB_RETRY_AFTER_CAP_MS = 30_000;
export const GITLAB_MAX_EXTRA_WAIT_MS = 60_000;
const MAX_ERROR_DETAIL = 300;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GitLabHttpOptions {
  /** Optional: anonymous access works for public projects. */
  token?: string | null;
  /** Test seams. */
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  timeoutMs?: number;
}

/** Upstream GitLab failure. `upstreamStatus` 0 ⇒ network error / timeout. */
export class GitLabHttpError extends ExternalServiceError {
  constructor(
    message: string,
    public readonly upstreamStatus: number,
    /** Redacted OAuth `error_description` / `error` / `message`, when the body had one. */
    public readonly upstreamDetail: string | null = null,
  ) {
    super(message);
    this.name = 'GitLabHttpError';
  }
}

export interface GitLabRestResponse<T> {
  data: T;
  headers: Headers;
}

export type QueryValue = string | number | boolean;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class GitLabHttp {
  private readonly token: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly timeoutMs: number;

  constructor(opts: GitLabHttpOptions = {}) {
    this.token = opts.token ? opts.token : null;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.timeoutMs = opts.timeoutMs ?? GITLAB_TIMEOUT_MS;
  }

  get hasToken(): boolean {
    return this.token !== null;
  }

  /** GET `/api/v4<path>`. `path` must already have its segments URL-encoded. */
  async rest<T>(path: string, query: Record<string, QueryValue> = {}): Promise<GitLabRestResponse<T>> {
    const url = this.buildUrl(`${REST_PREFIX}${path}`, query);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token) headers['PRIVATE-TOKEN'] = this.token;
    const res = await this.send('GET', url, headers);
    return { data: (await this.readJson(res, 'GET', path)) as T, headers: res.headers };
  }

  /** POST `/api/graphql`. Throws on HTTP failure or a non-empty `errors` array. */
  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const url = this.buildUrl(GRAPHQL_PATH, {});
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    // GraphQL's documented header auth is `Authorization: Bearer <token>`.
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await this.send('POST', url, headers, JSON.stringify({ query, variables }));
    const body = (await this.readJson(res, 'POST', GRAPHQL_PATH)) as {
      data?: T | null;
      errors?: { message?: unknown }[];
    } | null;
    if (body?.errors?.length) {
      const first = this.redact(String(body.errors[0]?.message ?? 'unknown error'));
      throw new GitLabHttpError(`GitLab GraphQL error: ${truncate(first)}`, 200, first);
    }
    if (!body || body.data == null) {
      throw new GitLabHttpError('GitLab GraphQL returned no data', 200);
    }
    return body.data;
  }

  // ---------- internals ----------

  private buildUrl(path: string, query: Record<string, QueryValue>): string {
    const url = new URL(path, GITLAB_ORIGIN);
    // Defense in depth: a crafted path (e.g. `//evil.example`) must not change the origin.
    if (url.origin !== GITLAB_ORIGIN) {
      throw new GitLabHttpError('Refusing a GitLab request outside https://gitlab.com', 0);
    }
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    return url.toString();
  }

  private redact(text: string): string {
    return redactSecret(text, this.token);
  }

  private async send(
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<Response> {
    const label = `${method} ${new URL(url).pathname}`;
    let extraWaitMs = 0;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        const reason =
          name === 'TimeoutError' || name === 'AbortError'
            ? `timed out after ${this.timeoutMs} ms`
            : String((err as Error | null)?.message ?? err);
        throw new GitLabHttpError(this.redact(`GitLab ${label} failed: ${truncate(reason)}`), 0);
      }

      if (res.status >= 300 && res.status < 400) {
        discard(res);
        const location = res.headers.get('location');
        let target = 'another location';
        if (location) {
          try {
            target = new URL(location, url).host;
          } catch {
            target = 'an invalid location';
          }
        }
        throw new GitLabHttpError(
          this.redact(`GitLab ${label} answered ${res.status} redirecting to ${target}; redirects are not followed`),
          res.status,
        );
      }

      if (isRetryable(res.status) && attempt < GITLAB_MAX_RETRIES) {
        const remaining = GITLAB_MAX_EXTRA_WAIT_MS - extraWaitMs;
        const delay = Math.min(this.retryDelay(res, attempt), remaining);
        if (delay > 0) {
          discard(res);
          await this.sleep(delay);
          extraWaitMs += delay;
          continue;
        }
      }

      if (!res.ok) throw await this.toHttpError(res, label);
      return res;
    }
  }

  private retryDelay(res: Response, attempt: number): number {
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    if (retryAfter !== null) return Math.min(retryAfter, GITLAB_RETRY_AFTER_CAP_MS);
    const base = GITLAB_BACKOFF_MS[attempt] ?? GITLAB_BACKOFF_MS[GITLAB_BACKOFF_MS.length - 1]!;
    const factor = 1 + (this.random() * 2 - 1) * GITLAB_JITTER;
    return Math.round(base * factor);
  }

  private async toHttpError(res: Response, label: string): Promise<GitLabHttpError> {
    let detail: string | null = null;
    try {
      const text = await res.text();
      detail = extractErrorDetail(text);
    } catch {
      detail = null;
    }
    const safe = detail ? this.redact(detail) : null;
    const suffix = safe ? `: ${truncate(safe)}` : '';
    return new GitLabHttpError(this.redact(`GitLab ${label} → ${res.status}${suffix}`), res.status, safe);
  }

  private async readJson(res: Response, method: string, path: string): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      throw new GitLabHttpError(
        this.redact(`GitLab ${method} ${path.split('?')[0]} returned a non-JSON body`),
        res.status,
      );
    }
  }
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** `Retry-After` as delta-seconds or an HTTP-date → ms (≥ 0); null when absent/invalid. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/** GitLab error bodies: `{message}`, `{error, error_description}`, or plain text. */
function extractErrorDetail(text: string): string | null {
  if (!text) return null;
  try {
    const json = JSON.parse(text) as Record<string, unknown> | null;
    if (json && typeof json === 'object') {
      const desc = json.error_description ?? json.message ?? json.error;
      if (typeof desc === 'string') return desc;
      if (desc != null) return JSON.stringify(desc);
    }
  } catch {
    // not JSON — fall through to the raw text
  }
  return text;
}

function truncate(s: string): string {
  return s.length > MAX_ERROR_DETAIL ? `${s.slice(0, MAX_ERROR_DETAIL)}…` : s;
}

function discard(res: Response): void {
  res.body?.cancel().catch(() => {});
}
