/**
 * Secret redaction for anything that may surface a credential: git stderr/stdout,
 * host HTTP error messages, connection-test failures. Pure, no I/O.
 *
 * Replaces with `***`:
 *  - each non-empty secret verbatim;
 *  - its `base64("<user>:<secret>")` form for both git usernames we use
 *    (`x-access-token` for GitHub, `oauth2` for GitLab) — the value carried in
 *    the per-invocation `Authorization: Basic` http.extraHeader;
 *  - any `//user:pass@` / `//token@` URL userinfo;
 *  - any `Authorization: Basic|Bearer <value>` and `PRIVATE-TOKEN: <value>` header value.
 */

const MASK = '***';

/** Usernames paired with a token in git's Basic auth header (see Q8 in the plan). */
const GIT_BASIC_USERNAMES = ['x-access-token', 'oauth2'] as const;

const AUTH_HEADER_RE = /(authorization\s*[:=]\s*(?:basic|bearer)\s+)[^\s'",;]+/gi;
const PRIVATE_TOKEN_HEADER_RE = /(private-token\s*[:=]\s*)[^\s'",;]+/gi;
/** `scheme://userinfo@` — userinfo has no `/`, `@` or whitespace. */
const URL_USERINFO_RE = /(\/\/)[^\s/@]+@/g;

function toBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

export function redactSecret(
  text: string,
  ...secrets: ReadonlyArray<string | null | undefined>
): string {
  let out = String(text ?? '');

  // Literal values first, longest first, so a secret that contains another is
  // fully masked before the shorter one could split it.
  const literals = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    literals.add(secret);
    for (const user of GIT_BASIC_USERNAMES) literals.add(toBase64(`${user}:${secret}`));
  }
  for (const literal of [...literals].sort((a, b) => b.length - a.length)) {
    out = out.split(literal).join(MASK);
  }

  return out
    .replace(AUTH_HEADER_RE, `$1${MASK}`)
    .replace(PRIVATE_TOKEN_HEADER_RE, `$1${MASK}`)
    .replace(URL_USERINFO_RE, `$1${MASK}@`);
}
