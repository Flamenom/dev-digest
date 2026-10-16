/**
 * L06 Eval Pipeline — auto-generated case names (spec §7, AC-8).
 *
 * ---------------------------------------------------------------------------
 * PURE. A title and the taken names in, a free name out.
 * ---------------------------------------------------------------------------
 * No imports at all. This file is inside the `eval-scoring-purity`
 * dependency-cruiser rule's `from` pattern (`pnpm arch`, `error`-severity), so
 * it must never reach `db/`, `adapters/`, `fastify` or the composition root.
 * In particular the collision check takes the taken names as an ARGUMENT — the
 * repository query that produces them (`takenNamesForOwner`) belongs to the
 * service, so that this rule stays testable with a plain array (AC-8's
 * "observable: pure helper test over a collision table").
 *
 * The naming rule exists to reproduce the design's `stripe-key-leak` /
 * `ssrf-webhook` / `missing-retry-after` list from real finding titles.
 */

/** Longest slug the rule will emit, before any collision suffix (§7). */
export const MAX_CASE_SLUG_LENGTH = 48;

/** Emitted when the title contains nothing sluggable at all (§7). */
export const FALLBACK_CASE_SLUG = 'case';

/**
 * Slugify a finding title (§7, AC-8), in exactly this order:
 *   lowercase → every run of non-`[a-z0-9]` becomes one `-` → trim `-`
 *   → cap at `MAX_CASE_SLUG_LENGTH` → empty result becomes `"case"`.
 *
 * Case-FOLDING here is unrelated to `scoring.ts`'s case-SENSITIVE path
 * normalisation: a name is a human label, a path is an identity.
 *
 * One detail the spec leaves open: capping can cut mid-run and leave a
 * trailing `-`, which would then compose into `foo--2` on collision. The
 * trailing `-` is therefore trimmed again AFTER the cap. This can only ever
 * shorten the result and never changes a slug that was already ≤ 48 chars.
 */
export function slugifyCaseName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_CASE_SLUG_LENGTH)
    .replace(/-+$/, '');
  return slug === '' ? FALLBACK_CASE_SLUG : slug;
}

/**
 * The first free name for `slug` given the names already taken within one
 * `(workspace_id, owner_id)` pair: `slug`, then `slug-2`, `slug-3`, … (§7).
 *
 * Numbering starts at 2 deliberately — the unsuffixed slug IS number one, so a
 * second `Stripe key leak` becomes `stripe-key-leak-2`, which reads as "the
 * second one" rather than as a version.
 *
 * Comparison is exact-string; the caller passes the names as stored. The
 * suffix may push the result past `MAX_CASE_SLUG_LENGTH`, which is correct:
 * truncating it back would re-collide with the name we just avoided.
 */
export function nextFreeName(slug: string, taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has(slug)) return slug;
  for (let n = 2; ; n += 1) {
    const candidate = `${slug}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
