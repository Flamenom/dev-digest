/** Per-source content caps sent to the classifier (token-budget guard). */
export const MAX_BODY_CHARS = 6_000;
export const MAX_ISSUE_CHARS = 6_000;
export const MAX_DOC_CHARS = 6_000;

/** Repo-relative docs fetched per classification (mentions beyond this are unavailable-marked). */
export const MAX_REPO_DOCS = 4;
/** External URLs recorded per classification (v1: never fetched — `unavailable`). */
export const MAX_EXTERNAL_URLS = 5;

/** File-list caps: paths + `@@ …@@` hunk headers ONLY — never patch bodies. */
export const MAX_FILES_LISTED = 100;
export const MAX_HUNK_HEADERS_PER_FILE = 20;
