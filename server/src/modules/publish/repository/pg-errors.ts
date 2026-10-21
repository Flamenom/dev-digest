/**
 * Postgres constraint-violation matching for the publish repository (plan T7).
 * Matched by SHAPE — postgres-js error `code` + `constraint_name`, walking a
 * possible `cause` chain — never `instanceof PostgresError`, so the `postgres`
 * types stay out of every signature (same pattern as eval / identity repos).
 */

export const PG_UNIQUE_VIOLATION = '23505';

/** AC-22 — at most one in-progress publication per PR (migration 0027). */
export const PR_IN_PROGRESS_UQ = 'review_publications_pr_in_progress_uq';

/** AC-35 — at most one live item per finding (migration 0027). */
export const FINDING_LIVE_UQ = 'review_publication_items_finding_live_uq';

/** The violated unique constraint's name, or null when `err` is not a unique violation. */
export function uniqueViolationConstraint(err: unknown): string | null {
  let e: unknown = err;
  for (let depth = 0; e && typeof e === 'object' && depth < 4; depth++) {
    const shaped = e as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };
    if (shaped.code === PG_UNIQUE_VIOLATION) {
      const name = shaped.constraint_name ?? shaped.constraint;
      return typeof name === 'string' ? name : '';
    }
    e = shaped.cause;
  }
  return null;
}
