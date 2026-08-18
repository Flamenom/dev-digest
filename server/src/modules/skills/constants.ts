/** Constants for the skills module (L02 — Skills Lab). */

/** Initial version recorded for a newly-created skill. */
export const INITIAL_SKILL_VERSION = 1;

/** Note attached to the v1 snapshot written on create. */
export const INITIAL_VERSION_NOTE = 'Initial version';

/** Default source when POST /skills omits it (import confirm posts 'community'). */
export const DEFAULT_SKILL_SOURCE = 'manual' as const;

// ---- Import limits (spec §3.3). Checked BEFORE any inflate happens. ----

/** Max size of an uploaded `.md` file. */
export const MD_MAX_BYTES = 256 * 1024;

/** Max COMPRESSED size of an uploaded `.zip` archive. */
export const ZIP_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Max UNCOMPRESSED size of the SKILL.md entry inside a zip, checked against the
 * entry's DECLARED size from the zip directory (zip-bomb guard: never inflate
 * first and measure after).
 */
export const SKILL_MD_MAX_BYTES = 256 * 1024;

/** Fallback-description truncation length (first paragraph, ~200 chars). */
export const DESCRIPTION_MAX_CHARS = 200;
