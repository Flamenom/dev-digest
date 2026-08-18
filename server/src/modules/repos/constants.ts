/**
 * F1 — repos module constants (extracted from routes.ts; no behaviour change).
 */

/** JobRunner kind for the asynchronous `git clone` job. */
export const CLONE_JOB_KIND = 'clone';

/** Clone depth — shallow clone (latest commit only) keeps imports fast. */
export const CLONE_DEPTH = 1;

/** Secret name (via the Secrets adapter) holding the GitHub PAT for private clones. */
export const GITHUB_TOKEN_SECRET = 'GITHUB_TOKEN';

/**
 * SSH (scp-like) GitHub remote: `git@github.com:owner/repo.git`. This form is not
 * a parseable URL, so it gets its own ANCHORED pattern. `^…$` matters: an
 * unanchored pattern would accept any string that merely *contains* github.com.
 */
export const GITHUB_SSH_URL_REGEX = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

/**
 * Allowed characters in a GitHub owner (user/org) or repository name. GitHub
 * itself permits only these, so anything else is rejected rather than passed to
 * `git clone` or used as a filesystem path segment. Notably this excludes `/`,
 * `\`, and the bare `.`/`..` traversal segments guarded below.
 */
export const GITHUB_NAME_REGEX = /^[A-Za-z0-9._-]+$/;

/** Protocols accepted for an https GitHub clone URL. */
export const ALLOWED_REPO_PROTOCOLS = ['https:'] as const;

/** Username embedded into an authenticated https github.com clone URL. */
export const GIT_TOKEN_USERNAME = 'x-access-token';

/** Host for which a token is embedded into an https clone URL. */
export const GITHUB_HTTPS_HOST = 'github.com';
