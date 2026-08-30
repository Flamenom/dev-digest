/* format.ts — pure display formatters shared across routes.
   Kept free of React and I/O so it can be imported anywhere and tested
   without mocks. */

/** Em dash used everywhere a numeric value is absent (never "0"). */
const EM_DASH = "—";

const MILLION = 1_000_000;
const THOUSAND = 1_000;

/**
 * Abbreviate a token count to one decimal place for compact display.
 *
 * `null` / `undefined` (and any non-finite value) render as an em dash so an
 * absent count is never mistaken for a real zero. Values ≥ 1,000,000 get an
 * `M` suffix, values ≥ 1,000 a `K` suffix; anything smaller is printed
 * verbatim.
 *
 * @example
 * formatTokensAbbrev(1_240_000); // "1.2M"
 * formatTokensAbbrev(8231);      // "8.2K"
 * formatTokensAbbrev(940);       // "940"
 * formatTokensAbbrev(null);      // "—"
 */
export function formatTokensAbbrev(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return EM_DASH;
  if (n >= MILLION) return `${(n / MILLION).toFixed(1)}M`;
  if (n >= THOUSAND) return `${(n / THOUSAND).toFixed(1)}K`;
  return String(n);
}
