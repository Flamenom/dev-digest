import type { HostRepoRef, RepoHost, RepoProvider } from '@devdigest/shared';

/**
 * Pure repo-identity primitives shared by every module that turns a repo row into
 * a git/host reference or a link. No I/O.
 *
 * Rows that predate GitLab support (or test fixtures without the columns) have no
 * provider/host → they are GitHub on github.com.
 */

/** Canonical host per provider (MVP: gitlab.com only, no self-managed). */
export const PROVIDER_HOST: Readonly<Record<RepoProvider, RepoHost>> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
};

export interface RepoIdentityRow {
  owner: string;
  name: string;
  fullName: string;
  provider?: RepoProvider | string | null;
  host?: RepoHost | string | null;
}

function toProvider(value: RepoIdentityRow['provider']): RepoProvider {
  return value === 'gitlab' ? 'gitlab' : 'github';
}

/** Repo row → host-neutral port reference (missing provider ⇒ github / github.com). */
export function hostRepoRef(row: RepoIdentityRow): HostRepoRef {
  const provider = toProvider(row.provider);
  const host: RepoHost =
    row.host === 'github.com' || row.host === 'gitlab.com' ? row.host : PROVIDER_HOST[provider];
  return { owner: row.owner, name: row.name, fullName: row.fullName, provider, host };
}

/**
 * One path segment of a GitHub owner/repo or a GitLab namespace/project.
 * Both hosts restrict paths to these characters; `.`/`..` are never valid.
 */
const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

function assertSafeFullName(fullName: string): void {
  const segments = fullName.split('/');
  const ok =
    segments.length >= 2 &&
    segments.every((s) => SEGMENT_RE.test(s) && s !== '.' && s !== '..');
  if (!ok) throw new Error(`Invalid repository path: ${JSON.stringify(fullName)}`);
}

/** Canonical https project URL, e.g. `https://gitlab.com/group/sub/project`. */
export function repoWebUrl(provider: RepoProvider, host: RepoHost | string, fullName: string): string {
  assertSafeFullName(fullName);
  const h = host === 'github.com' || host === 'gitlab.com' ? host : PROVIDER_HOST[provider];
  return `https://${h}/${fullName}`;
}

/**
 * Clone/fetch remote URL — ALWAYS tokenless. Credentials are supplied per git
 * invocation by the git adapter (http.extraHeader via GIT_CONFIG_*), never here.
 */
export function cloneRemoteUrl(provider: RepoProvider, fullName: string): string {
  assertSafeFullName(fullName);
  return `https://${PROVIDER_HOST[provider]}/${fullName}.git`;
}
