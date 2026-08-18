import { type Repo } from '@devdigest/shared';
import * as t from '../../db/schema.js';
import { AppError } from '../../platform/errors.js';
import {
  ALLOWED_REPO_PROTOCOLS,
  GITHUB_NAME_REGEX,
  GITHUB_SSH_URL_REGEX,
  GIT_TOKEN_USERNAME,
  GITHUB_HTTPS_HOST,
} from './constants.js';

/**
 * F1 — repos pure helpers (extracted from routes.ts; no behaviour change).
 * Pure functions only — no I/O, no DB, no container.
 */

/**
 * Validate an owner or repository segment. These values become BOTH a `git clone`
 * argument and a filesystem path segment under `cloneDir` (see
 * adapters/git/simple-git.ts `clonePathFor`), so they are checked against an
 * allowlist rather than merely "not empty". `.`/`..` are rejected explicitly:
 * they satisfy the charset but would escape the clone directory via path.join.
 */
function assertSafeSegment(kind: 'owner' | 'repository', value: string, url: string): string {
  if (!GITHUB_NAME_REGEX.test(value) || value === '.' || value === '..') {
    throw new AppError('invalid_repo_url', `Invalid ${kind} in repository URL '${url}'`, 400);
  }
  return value;
}

/**
 * Parse `owner`/`name` from a GitHub URL (https or scp-like ssh form).
 *
 * Parses instead of pattern-matching on purpose. The previous implementation ran
 * one UNANCHORED regex over the raw string, which accepted any URL that merely
 * contained `github.com/owner/repo` — so `https://internal-host/github.com/a/b`
 * parsed as `a/b` and was then handed verbatim to `git clone` (arbitrary-host
 * fetch / SSRF). It also accepted `..` as an owner, escaping the clone directory.
 * Both are closed by resolving the host through `new URL()` and validating each
 * path segment.
 */
export function parseRepoUrl(url: string): { owner: string; name: string } {
  const trimmed = url.trim();

  // git@github.com:owner/repo.git — not a URL, so match its anchored shape.
  const ssh = trimmed.match(GITHUB_SSH_URL_REGEX);
  if (ssh?.[1] && ssh[2]) {
    return {
      owner: assertSafeSegment('owner', ssh[1], url),
      name: assertSafeSegment('repository', ssh[2], url),
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppError('invalid_repo_url', `Not a valid repository URL: '${url}'`, 400);
  }

  // Host allowlist. Rejects file://, http://169.254.169.254/…, and any host that
  // merely mentions github.com in its path or query.
  if (!(ALLOWED_REPO_PROTOCOLS as readonly string[]).includes(parsed.protocol)) {
    throw new AppError(
      'invalid_repo_url',
      `Only https:// GitHub URLs are supported (got '${parsed.protocol}')`,
      400,
    );
  }
  if (parsed.hostname.toLowerCase() !== GITHUB_HTTPS_HOST) {
    throw new AppError('invalid_repo_url', `Only github.com repositories are supported`, 400);
  }

  // `new URL` normalizes `.`/`..` out of the pathname, so the segments below are
  // already resolved — assertSafeSegment is the belt to that braces.
  const segments = parsed.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  if (segments.length !== 2) {
    throw new AppError(
      'invalid_repo_url',
      `Could not parse owner/repo from '${url}' — expected https://github.com/<owner>/<repo>`,
      400,
    );
  }

  return {
    owner: assertSafeSegment('owner', segments[0]!, url),
    name: assertSafeSegment('repository', segments[1]!, url),
  };
}

/**
 * Embed a token into an https github.com URL so private clones authenticate
 * non-interactively. SSH/non-GitHub URLs are left untouched.
 */
export function withGitHubToken(url: string, token: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && u.hostname === GITHUB_HTTPS_HOST) {
      u.username = GIT_TOKEN_USERNAME;
      u.password = token;
      return u.toString();
    }
  } catch {
    /* non-URL (e.g. git@github.com:...) — leave as-is */
  }
  return url;
}

/** Map a persisted repo row to the API `Repo` DTO. */
export function toRepoDto(row: typeof t.repos.$inferSelect): Repo {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    owner: row.owner,
    name: row.name,
    full_name: row.fullName,
    default_branch: row.defaultBranch,
    clone_path: row.clonePath,
    last_polled_at: row.lastPolledAt?.toISOString() ?? null,
    created_by: row.createdBy,
  };
}
