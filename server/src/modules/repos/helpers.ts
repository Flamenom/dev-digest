import type { RepoHost, RepoProvider, RepoSyncState, RepoWithHost } from '@devdigest/shared';
import * as t from '../../db/schema.js';
import { AppError } from '../../platform/errors.js';
import { PROVIDER_HOST, repoWebUrl } from '../_shared/repo-ref.js';
import {
  ALLOWED_REPO_PROTOCOLS,
  GITHUB_NAME_REGEX,
  GITHUB_SSH_URL_REGEX,
  GITLAB_CONSECUTIVE_SPECIAL_REGEX,
  GITLAB_MAX_SEGMENTS,
  GITLAB_MIN_SEGMENTS,
  GITLAB_SEGMENT_REGEX,
  GITLAB_SSH_URL_REGEX,
  RAW_REPO_URL_FORBIDDEN_REGEX,
  SCP_REMOTE_REGEX,
  UNSUPPORTED_REPO_HOST_CODE,
  UNSUPPORTED_REPO_HOST_MESSAGE,
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
  if (parsed.hostname.toLowerCase() !== PROVIDER_HOST.github) {
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

/** A repository URL resolved to a supported host (github.com | gitlab.com). */
export interface ParsedRepoUrl {
  provider: RepoProvider;
  host: RepoHost;
  /** GitHub: the owner. GitLab: the full namespace path (may contain `/`). */
  owner: string;
  name: string;
  fullName: string;
}

function invalidUrl(url: string, detail: string): AppError {
  return new AppError('invalid_repo_url', `Invalid repository URL '${url}': ${detail}`, 400);
}

function unsupportedHost(): AppError {
  return new AppError(UNSUPPORTED_REPO_HOST_CODE, UNSUPPORTED_REPO_HOST_MESSAGE, 400);
}

function github(url: string): ParsedRepoUrl {
  const { owner, name } = parseRepoUrl(url);
  return { provider: 'github', host: 'github.com', owner, name, fullName: `${owner}/${name}` };
}

/**
 * Validate a gitlab.com project path (`group/sub…/project`) and split it into
 * namespace + project (AC-7/AC-10). Also used on the `path_with_namespace` the
 * host returns, so a hostile/odd API response can never become a clone path.
 */
export function parseGitLabPath(path: string, url = path): ParsedRepoUrl {
  const segments = path.split('/');
  if (segments.length < GITLAB_MIN_SEGMENTS || segments.length > GITLAB_MAX_SEGMENTS) {
    throw invalidUrl(
      url,
      `a gitlab.com project path needs ${GITLAB_MIN_SEGMENTS}–${GITLAB_MAX_SEGMENTS} segments (got ${segments.length})`,
    );
  }
  for (const segment of segments) {
    if (!GITLAB_SEGMENT_REGEX.test(segment) || GITLAB_CONSECUTIVE_SPECIAL_REGEX.test(segment)) {
      throw invalidUrl(url, `invalid path segment ${JSON.stringify(segment)}`);
    }
  }
  const name = segments[segments.length - 1]!;
  const owner = segments.slice(0, -1).join('/');
  return { provider: 'gitlab', host: 'gitlab.com', owner, name, fullName: segments.join('/') };
}

/** Strip the GitLab route suffix (`/-/…`), one trailing `/`, and `.git`. */
function normaliseGitLabPath(path: string): string {
  let p = path.replace(/^\/+/, '');
  const route = p.indexOf('/-/');
  if (route >= 0) p = p.slice(0, route);
  else if (p.endsWith('/-')) p = p.slice(0, -2);
  if (p.endsWith('/')) p = p.slice(0, -1);
  if (p.toLowerCase().endsWith('.git')) p = p.slice(0, -4);
  return p;
}

/**
 * Parse a repository URL for ANY supported host (github.com | gitlab.com).
 *
 * Order matters for safety:
 *   1. Raw-string guard (`%`, `\`, whitespace, `.`/`..` segments) BEFORE
 *      `new URL`, which would otherwise normalise `%2e%2e` / `..` away (AC-10).
 *   2. SSH scp forms, matched by anchored patterns.
 *   3. `https:` only, no userinfo, no port, host exactly github.com | gitlab.com
 *      — everything else is `unsupported_repo_host` with no network call (AC-9).
 *   4. GitHub delegates to the UNCHANGED `parseRepoUrl` (AC-11).
 */
export function parseRepoUrlHost(url: string): ParsedRepoUrl {
  const trimmed = url.trim();
  if (!trimmed) throw invalidUrl(url, 'empty');
  if (RAW_REPO_URL_FORBIDDEN_REGEX.test(trimmed)) {
    throw invalidUrl(url, 'percent-encoding, backslashes, whitespace and ./.. segments are not allowed');
  }

  if (GITHUB_SSH_URL_REGEX.test(trimmed)) return github(trimmed);
  const gitlabSsh = trimmed.match(GITLAB_SSH_URL_REGEX);
  if (gitlabSsh?.[1]) return parseGitLabPath(normaliseGitLabPath(gitlabSsh[1]), url);
  const scp = trimmed.match(SCP_REMOTE_REGEX);
  if (scp) {
    const host = scp[1]!.toLowerCase();
    if (host !== PROVIDER_HOST.github && host !== PROVIDER_HOST.gitlab) throw unsupportedHost();
    throw invalidUrl(url, 'expected git@<host>:<path>.git');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppError('invalid_repo_url', `Not a valid repository URL: '${url}'`, 400);
  }
  if (
    !(ALLOWED_REPO_PROTOCOLS as readonly string[]).includes(parsed.protocol) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== ''
  ) {
    throw unsupportedHost();
  }

  const host = parsed.hostname.toLowerCase();
  if (host === PROVIDER_HOST.github) return github(trimmed);
  if (host !== PROVIDER_HOST.gitlab) throw unsupportedHost();
  // `pathname` already excludes `?query` and `#fragment` (AC-8).
  return parseGitLabPath(normaliseGitLabPath(parsed.pathname), url);
}

export interface RepoDtoOptions {
  /** In-memory single-flight PR-list sync is running for this repo (never persisted). */
  syncRunning?: boolean;
}

function syncStateOf(row: typeof t.repos.$inferSelect, opts: RepoDtoOptions): RepoSyncState {
  if (opts.syncRunning) return 'running';
  return row.lastSyncError ? 'failed' : 'idle';
}

function webUrlOf(provider: RepoProvider, host: RepoHost, fullName: string): string {
  try {
    return repoWebUrl(provider, host, fullName);
  } catch {
    // A legacy/odd full_name must not break the whole list — link the host root.
    return `https://${host}`;
  }
}

/** Map a persisted repo row to the API `RepoWithHost` DTO (AC-36). */
export function toRepoDto(row: typeof t.repos.$inferSelect, opts: RepoDtoOptions = {}): RepoWithHost {
  const provider: RepoProvider = row.provider === 'gitlab' ? 'gitlab' : 'github';
  const host: RepoHost =
    row.host === 'github.com' || row.host === 'gitlab.com' ? row.host : PROVIDER_HOST[provider];
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
    provider,
    host,
    web_url: webUrlOf(provider, host, row.fullName),
    last_synced_at: row.lastSyncedAt?.toISOString() ?? null,
    last_attempt_at: row.lastAttemptAt?.toISOString() ?? null,
    sync_state: syncStateOf(row, opts),
    last_sync_error: row.lastSyncError ?? null,
  };
}
