/**
 * F1 — repos module constants (extracted from routes.ts; no behaviour change).
 */

/** JobRunner kind for the asynchronous `git clone` job. */
export const CLONE_JOB_KIND = 'clone';

/** Clone depth — shallow clone (latest commit only) keeps imports fast. */
export const CLONE_DEPTH = 1;

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

/** Upper bound on a submitted repository URL (21 GitLab segments fit easily). */
export const MAX_REPO_URL_LENGTH = 2048;

/** Protocols accepted for an https GitHub clone URL. */
export const ALLOWED_REPO_PROTOCOLS = ['https:'] as const;

/**
 * Raw-input guard, applied BEFORE `new URL` (AC-10). The WHATWG parser silently
 * resolves `.`/`..` segments (including percent-encoded `%2e%2e`) and turns `\`
 * into `/`, so traversal must be refused on the string the user typed:
 *   - `%` (any percent-encoding), `\`, and any whitespace inside the URL;
 *   - a bare `.` or `..` path segment (after `/` or the scp `:`).
 */
export const RAW_REPO_URL_FORBIDDEN_REGEX = /[%\\\s]|(?:^|[/:])\.{1,2}(?=[/?#]|$)/;

/** Generic scp-like remote (`user@host:path`) — used only to name its host in the error. */
export const SCP_REMOTE_REGEX = /^[^@/\s]+@([^:/\s]+):/;

/** SSH (scp-like) gitlab.com remote: `git@gitlab.com:<group…>/<project>(.git)`. Anchored. */
export const GITLAB_SSH_URL_REGEX = /^git@gitlab\.com:([^\s]+)$/i;

/**
 * One gitlab.com namespace/project path segment: letters, digits, `_`, `-`, `.`;
 * must start and end with a letter, digit or `_` (AC-10).
 */
export const GITLAB_SEGMENT_REGEX = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/;

/** Consecutive special characters (`..`, `.-`, `-.`, `--`) are never valid in a segment. */
export const GITLAB_CONSECUTIVE_SPECIAL_REGEX = /[.-]{2}/;

/** A gitlab.com project path is 1–20 group levels plus the project (AC-7). */
export const GITLAB_MIN_SEGMENTS = 2;
export const GITLAB_MAX_SEGMENTS = 21;

/** Error code for any host other than github.com / gitlab.com (AC-9). */
export const UNSUPPORTED_REPO_HOST_CODE = 'unsupported_repo_host';
export const UNSUPPORTED_REPO_HOST_MESSAGE =
  'Only github.com and gitlab.com repositories are supported';

/**
 * Patterns in a (redacted) git error that mean "gitlab.com refused our
 * credentials / found nothing we may read" — mapped to the Settings hint (AC-13).
 */
export const GIT_AUTH_FAILURE_REGEX =
  /authentication failed|could not read username|terminal prompts disabled|access denied|http basic|\b40[13]\b|repository not found|not found/i;

/**
 * User-facing hint for a GitLab clone/fetch auth failure (AC-12/13). The token
 * must carry the `api` scope (specs/2026-10-20-gitlab-comments.md, AC-27).
 */
export const GITLAB_CLONE_AUTH_MESSAGE =
  'GitLab refused the clone: connect a GitLab token in Settings → API keys (it needs the api scope and access to this project).';

/**
 * git stderr when the group/project limits "Enabled Git access protocols" to
 * SSH only: `remote: Git access over HTTP is not allowed` (followed by a 403,
 * which would otherwise match GIT_AUTH_FAILURE_REGEX). Checked FIRST — no token
 * can fix it, so the token hint would be wrong.
 */
export const GITLAB_HTTP_GIT_DISABLED_REGEX = /git access over https? is not allowed/i;

/** Error code for a gitlab.com clone refused because HTTP(S) Git access is disabled. */
export const GITLAB_HTTP_GIT_DISABLED_CODE = 'gitlab_http_git_disabled';
export const GITLAB_HTTP_GIT_DISABLED_MESSAGE =
  'GitLab refused the clone: this group or project only allows Git over SSH. Ask a group owner to enable HTTP(S) under Settings → General → Visibility, project features, permissions → Enabled Git access protocols.';
