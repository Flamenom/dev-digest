/* monitoring/scrub.ts — pure, last-line scrubber for every web Sentry event (AC-36, AC-38).

   First line (structural, allowlist):
   - `request`: only the URL without query/fragment and the `user-agent` header
     survive — cookies, body (`data`), `query_string`, `env` and every other
     header are dropped;
   - `breadcrumbs` are emptied (the SDK already runs with `maxBreadcrumbs: 0`);
   - `user` keeps `id` only (no email, name, avatar or IP).
   Second line (pattern masking): EVERY remaining string in the event (message,
   exception values, extra, contexts, tags, frame paths, …) goes through
   `scrubString`, which masks credential shapes.

   No Sentry runtime import — the event is typed structurally so this module
   stays import-anywhere and testable without the SDK. */

export const MASK = "[Filtered]";

/** Upper bound on the walk — events are shallow; this only guards pathological input. */
const MAX_DEPTH = 12;

type Replacer = readonly [RegExp, string];

/** Order matters: specific token shapes first, generic `key=value` rules last. */
const PATTERNS: readonly Replacer[] = [
  // Session cookie (name=value, any position in a Cookie / Set-Cookie string).
  [/((?:__Host-)?ddg_session=)[^;\s"'&]+/gi, `$1${MASK}`],
  // Personal API token.
  [/ddg_pat_[A-Za-z0-9_-]+/g, `ddg_pat_${MASK}`],
  // `scheme://user:pass@` / `scheme://token@` URL userinfo (git remotes, DB URLs).
  [/(\/\/)[^\s/@"']+@/g, `$1${MASK}@`],
  // Authorization header values (Bearer / Basic / token).
  [/(authorization\s*[:=]\s*)(?:(?:basic|bearer|token)\s+)?[^\s'",;]+/gi, `$1${MASK}`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  [/(private-token\s*[:=]\s*)[^\s'",;]+/gi, `$1${MASK}`],
  // JWTs (Google ID tokens, any signed token).
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, MASK],
  // GitHub tokens.
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, MASK],
  // GitLab tokens (glpat-, gloas-, gldt-, glrt-, glptt-, …).
  [/\bgl[a-z]{1,6}-[A-Za-z0-9_-]{16,}/g, MASK],
  // LLM provider keys (OpenAI / OpenRouter / Anthropic `sk-…`), Google API keys, Google client secret.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],
  [/\bGOCSPX-[A-Za-z0-9_-]+/g, MASK],
  // OAuth / token query params (also in fragments and free text `code=…`).
  [
    /([?&#;\s]|^)(code|state|id_token|access_token|refresh_token|token|client_secret|password)=[^&#\s"']*/gi,
    `$1$2=${MASK}`,
  ],
  // `"secret": "…"` / `password: …` style key-value pairs in serialized text.
  [
    /((?:"|')?(?:password|passwd|secret|client_secret|master_key|api_key|apikey|token|cookie|set-cookie)(?:"|')?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/gi,
    `$1${MASK}`,
  ],
];

/** Masks every known credential shape inside a free-text string. */
export function scrubString(input: string): string {
  let out = input;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Drops query string and fragment from a URL (relative or absolute). */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

function scrubDeep(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH || seen.has(value)) return MASK;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = scrubDeep(item, depth + 1, seen);
  }
  return out;
}

/** Minimal structural view of the event fields the scrubber rewrites. */
interface ScrubbableEvent {
  request?: { url?: string; headers?: Record<string, string> };
  breadcrumbs?: unknown[];
  user?: { id?: string | number } | null;
}

function pickUserAgent(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "user-agent") return { "User-Agent": value };
  }
  return undefined;
}

/**
 * Returns a scrubbed COPY of the event (the input is not mutated). Generic so
 * the Sentry `ErrorEvent` type flows through `beforeSend` unchanged.
 */
export function scrubEvent<E extends ScrubbableEvent>(event: E): E {
  const structural: Record<string, unknown> = { ...(event as object) };

  if (event.request) {
    const headers = pickUserAgent(event.request.headers);
    structural.request = {
      ...(event.request.url ? { url: stripQuery(event.request.url) } : {}),
      ...(headers ? { headers } : {}),
    };
  }

  if ("breadcrumbs" in event) structural.breadcrumbs = [];

  if (event.user) {
    const id = event.user.id;
    if (id !== undefined && id !== null && id !== "") structural.user = { id: String(id) };
    else delete structural.user;
  }

  return scrubDeep(structural, 0, new WeakSet()) as E;
}
