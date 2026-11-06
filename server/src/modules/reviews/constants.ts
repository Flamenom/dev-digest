/**
 * Review module constants.
 */

/**
 * Studio review strategy. 'single-pass' = send the WHOLE diff in ONE LLM call.
 * We deliberately do NOT use 'auto'/map-reduce by default: map-reduce makes one
 * call PER FILE, which is slow and fragile (any single file's transient 5xx
 * fails the entire run) and unnecessary — the whole diff already fits the
 * model's context.
 */
export const REVIEW_STRATEGY = 'single-pass' as const;

/**
 * Error code for a run-all-enabled-agents request when the workspace has no
 * enabled agent (AC-61). A plain constant, not a shared contract (Rec1): the
 * client keeps its own copy in `RunReviewDropdown/constants.ts`.
 */
export const NO_ENABLED_AGENTS = 'no_enabled_agents' as const;
