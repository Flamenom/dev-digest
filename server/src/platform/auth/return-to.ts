/**
 * Post-sign-in return target sanitizer (AC-16): only a same-origin relative
 * path survives; anything else falls back to the app home `/`.
 */

const HOME = '/';
const MAX_LENGTH = 2048;
// C0 controls, DEL and C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const PROBE_ORIGIN = 'https://return-to.invalid';

function isSafePath(candidate: string): boolean {
  if (!candidate.startsWith('/')) return false; // absolute URL, scheme (javascript:), relative
  if (candidate.startsWith('//')) return false; // protocol-relative
  if (candidate.includes('\\')) return false; // `/\evil.io` and any backslash variant
  if (CONTROL_CHARS.test(candidate)) return false; // tab/newline tricks
  return true;
}

export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) return HOME;
  if (!isSafePath(raw)) return HOME;

  // Encoded variants (`/%2F%2Fevil.io`, `/%5Cevil.io`, `%0a`) after one decode.
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return HOME;
  }
  if (!isSafePath(decoded)) return HOME;

  // Belt and braces: the URL parser must agree it stays on our origin.
  try {
    if (new URL(raw, PROBE_ORIGIN).origin !== PROBE_ORIGIN) return HOME;
    if (new URL(decoded, PROBE_ORIGIN).origin !== PROBE_ORIGIN) return HOME;
  } catch {
    return HOME;
  }
  return raw;
}
