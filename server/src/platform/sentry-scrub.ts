/**
 * Pure event scrubber applied in the Sentry adapter's `beforeSend` (AC-36/37/38).
 * No Sentry import: the event is typed structurally, so this file stays in the
 * platform ring and is hermetically testable.
 *
 * Defence in depth — breadcrumbs, request bodies, cookies, local variables and
 * default PII are already disabled at `init`; this is the second line:
 *  - request: drop `data`, `cookies`, `query_string`, `env`; headers allowlisted
 *    to `user-agent` + `content-type`; the query is stripped from `url`;
 *  - user: keep `id` only;
 *  - breadcrumbs: dropped;
 *  - `extra` / `contexts` / `tags`: keys that look sensitive are dropped;
 *  - every remaining string in exception values, `message`, `extra`,
 *    `contexts`, `tags`, `transaction` and `request.url` goes through
 *    `scrubString` = `redactSecret` + token-shape regexes.
 */
import { redactSecret } from './redact.js';

const MASK = '***';

/**
 * Structural subset of a Sentry event — only the parts we touch.
 *
 * Deliberately WITHOUT index signatures: Sentry's `ErrorEvent` / `Exception` /
 * `RequestEventData` are interfaces (no implicit index signature), so an index
 * signature here would make the SDK event unassignable and force a cast at the
 * adapter boundary. Every field is `unknown`-typed and narrowed at runtime.
 */
export type ScrubbableEvent = {
  message?: unknown;
  transaction?: unknown;
  exception?: { values?: Array<{ type?: unknown; value?: unknown; stacktrace?: unknown }> };
  request?: {
    url?: unknown;
    data?: unknown;
    cookies?: unknown;
    query_string?: unknown;
    headers?: unknown;
    env?: unknown;
  };
  user?: unknown;
  breadcrumbs?: unknown;
  extra?: unknown;
  contexts?: unknown;
  tags?: unknown;
};

const ALLOWED_HEADERS = new Set(['user-agent', 'content-type']);

/** Keys whose VALUE is presumed sensitive — dropped from extra/contexts/tags. */
const SENSITIVE_KEY_RE = /(pass|secret|token|key|cookie|auth|session|code|state|dsn)/i;

/** Ordered token-shape patterns; each match (or its value group) becomes `***`. */
const TOKEN_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // personal API tokens (platform/crypto/tokens.ts API_TOKEN_PREFIX)
  [/ddg_pat_[A-Za-z0-9_-]+/g, MASK],
  // session cookie (name=value)
  [/(__Host-ddg_session=)[^;\s"']+/g, `$1${MASK}`],
  // OAuth callback params in any URL / text
  [/([?&](?:code|state|id_token|access_token|refresh_token)=)[^&\s#"']+/gi, `$1${MASK}`],
  // GitHub (classic + fine-grained), GitLab, OpenAI/Anthropic/OpenRouter shapes
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}/g, MASK],
  // Google OAuth client secret
  [/\bGOCSPX-[A-Za-z0-9_-]{8,}/g, MASK],
  // JWTs (id_token, etc.)
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, MASK],
];

/** Credential redaction for one string (same `redactSecret` as logs + 5xx bodies). */
export function scrubString(s: string, secrets: ReadonlyArray<string | null | undefined> = []): string {
  let out = redactSecret(s, ...secrets);
  for (const [re, repl] of TOKEN_PATTERNS) out = out.replace(re, repl);
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-scrub any JSON-ish value: strings redacted, sensitive keys dropped. */
function scrubValue(
  v: unknown,
  secrets: ReadonlyArray<string | null | undefined>,
  depth = 0,
): unknown {
  if (depth > 12) return '[depth-limit]';
  if (typeof v === 'string') return scrubString(v, secrets);
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, secrets, depth + 1));
  if (isPlainObject(v)) return scrubRecord(v, secrets, depth + 1);
  return v;
}

function scrubRecord(
  rec: Record<string, unknown>,
  secrets: ReadonlyArray<string | null | undefined>,
  depth = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(rec)) {
    if (SENSITIVE_KEY_RE.test(k)) continue;
    out[k] = scrubValue(val, secrets, depth);
  }
  return out;
}

function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * Return a scrubbed copy of `event` (the input is not mutated).
 * `secrets` = literal values to mask (DB passwords, master key, client secret…).
 */
export function scrubEvent<E extends ScrubbableEvent>(
  event: E,
  secrets: ReadonlyArray<string | null | undefined> = [],
): E {
  // Widened working copy: the scrubbed values are plain JSON-ish data that may
  // not match E's precise field types (e.g. a narrowed `user`).
  const out: ScrubbableEvent = { ...event };

  delete out.breadcrumbs;

  if (typeof out.message === 'string') out.message = scrubString(out.message, secrets);
  else if (isPlainObject(out.message)) out.message = scrubValue(out.message, secrets);
  if (typeof out.transaction === 'string') {
    out.transaction = scrubString(stripQuery(out.transaction), secrets);
  }

  if (out.exception?.values) {
    out.exception = {
      ...out.exception,
      values: out.exception.values.map((ex) => {
        const copy = { ...ex };
        if (typeof copy.value === 'string') copy.value = scrubString(copy.value, secrets);
        if (typeof copy.type === 'string') copy.type = scrubString(copy.type, secrets);
        // Local variables are disabled at init; drop any that slipped through.
        if (isPlainObject(copy.stacktrace)) {
          const st = copy.stacktrace as { frames?: unknown };
          if (Array.isArray(st.frames)) {
            copy.stacktrace = {
              ...st,
              frames: st.frames.map((f) => {
                if (!isPlainObject(f)) return f;
                const { vars: _vars, ...rest } = f;
                return rest;
              }),
            };
          }
        }
        return copy;
      }),
    };
  }

  if (out.request) {
    const req = { ...out.request };
    delete req.data;
    delete req.cookies;
    delete req.query_string;
    delete req.env;
    if (typeof req.url === 'string') req.url = scrubString(stripQuery(req.url), secrets);
    if (isPlainObject(req.headers)) {
      const headers: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (ALLOWED_HEADERS.has(k.toLowerCase()) && typeof v === 'string') {
          headers[k] = scrubString(v, secrets);
        }
      }
      req.headers = headers;
    } else {
      delete req.headers;
    }
    out.request = req;
  }

  if (out.user !== undefined) {
    const id = isPlainObject(out.user) ? out.user.id : undefined;
    if (typeof id === 'string' || typeof id === 'number') out.user = { id };
    else delete out.user;
  }

  if (isPlainObject(out.extra)) out.extra = scrubRecord(out.extra, secrets);
  if (isPlainObject(out.contexts)) out.contexts = scrubRecord(out.contexts, secrets);
  if (isPlainObject(out.tags)) out.tags = scrubRecord(out.tags, secrets);

  // Sound in practice: every field keeps its input kind (strings stay strings,
  // records stay records, arrays stay arrays) or is removed — and every field
  // E's base type touches is optional.
  return out as E;
}
