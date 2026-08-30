/**
 * Input-budget and per-source caps for the PR Brief generation
 * (spec `specs/2026-08-27-pr-brief.md`, NFR-3).
 *
 * Deliberately duplicated rather than imported from `reviews/intent-constants.ts`:
 * cross-module imports are forbidden (`no-cross-module`), and the two budgets are
 * free to diverge — the brief never sends hunk bodies (AC-2), so its input scales
 * with FILE COUNT, not diff size.
 */

/** NFR-3: the assembled prompt is capped at 12,000 input tokens. */
export const MAX_INPUT_TOKENS = 12_000;

/**
 * Rough chars→tokens estimator, matching the one the intent classifier already
 * reports (`reviews/intent-deriver.ts:205`, `Math.ceil(totalChars / 4)`), so the
 * two features measure their budgets on the same scale.
 */
export const CHARS_PER_TOKEN = 4;

/** Per-source content caps (token-budget guard) before the NFR-3 truncation pass. */
export const MAX_BODY_CHARS = 6_000;
export const MAX_ISSUE_CHARS = 6_000;
export const MAX_DOC_CHARS = 6_000;

/** Per-file diff STATISTICS listed in the prompt — path + counts only, never a patch body. */
export const MAX_FILES_LISTED = 100;

/** Grounded findings listed in the prompt (already-redacted titles only, AC-39). */
export const MAX_FINDINGS_LISTED = 40;
