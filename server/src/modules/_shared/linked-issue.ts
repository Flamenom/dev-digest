import type {
  HostRepoRef,
  IssueMeta,
  PullRequestHost,
  RepoProvider,
  RepoRef,
} from '@devdigest/shared';
import { hostRepoRef } from './repo-ref.js';

/**
 * Linked-issue resolution shared by the Intent Layer (`reviews/intent-deriver`)
 * and PR Brief (`brief/service`) — Q4 requires the brief to resolve the linked
 * issue exactly as `deriveIntent` does, so both call this one helper.
 *
 * Pure apart from the injected host calls: no container, no sibling module.
 */

/** Explicit issue link: `closes|fixes|resolves #N` (first match wins). */
export function extractIssueRef(body: string | null | undefined): number | undefined {
  const m = (body ?? '').match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
  return m?.[1] ? Number(m[1]) : undefined;
}

/** Repo identity as both services see it. Absent provider/fullName ⇒ GitHub on github.com. */
export interface LinkedIssueRepo {
  owner: string;
  name: string;
  fullName?: string;
  provider?: RepoProvider | string | null;
  host?: string | null;
}

/** Explicit deps — the same `github` / `prHost` bindings both services already receive. */
export interface LinkedIssueDeps {
  /** GitHub linked-issue path (unchanged): `GitHubClient.getIssue`, throws on failure. */
  github: () => Promise<{ getIssue(repo: RepoRef, n: number): Promise<IssueMeta> }>;
  /**
   * Provider-neutral read-side host, used for non-GitHub repos only: `getIssue`
   * → null when unavailable; `getLinkedIssueNumber` → the same-project issue
   * the MR closes.
   */
  prHost: (provider: RepoProvider) => Promise<Pick<PullRequestHost, 'getIssue' | 'getLinkedIssueNumber'>>;
}

export type LinkedIssue =
  | { status: 'fetched'; ref: string; title: string; body: string | null }
  | { status: 'unavailable'; ref: string };

function toHostRef(repo: LinkedIssueRepo): HostRepoRef {
  return hostRepoRef({ ...repo, fullName: repo.fullName ?? `${repo.owner}/${repo.name}` });
}

/**
 * Resolve + fetch the PR's linked issue. `undefined` ⇒ the PR links no issue;
 * `unavailable` ⇒ linked but not fetchable (any failure, incl. a
 * confidential/404 GitLab issue — AC-23); else the fetched issue.
 *
 * GitHub: body regex + `GitHubClient.getIssue`, byte-identical to pre-GitLab.
 * GitLab: body regex, else the MR's `closes_issues` relation (same project only).
 * The issue text is returned RAW — the prompt builders wrap it as untrusted;
 * never wrap or strip it here.
 */
export async function fetchLinkedIssue(
  deps: LinkedIssueDeps,
  repo: LinkedIssueRepo,
  prNumber: number,
  body: string | null,
): Promise<LinkedIssue | undefined> {
  const ref = toHostRef(repo);
  if (ref.provider === 'github') {
    const issueNumber = extractIssueRef(body);
    if (issueNumber == null) return undefined;
    try {
      const gh = await deps.github();
      const meta = await gh.getIssue({ owner: repo.owner, name: repo.name }, issueNumber);
      return { status: 'fetched', ref: `#${issueNumber}`, title: meta.title, body: meta.body ?? null };
    } catch {
      return { status: 'unavailable', ref: `#${issueNumber}` };
    }
  }

  let issueNumber = extractIssueRef(body);
  let host: Pick<PullRequestHost, 'getIssue' | 'getLinkedIssueNumber'>;
  try {
    host = await deps.prHost(ref.provider);
    issueNumber ??= (await host.getLinkedIssueNumber(ref, prNumber)) ?? undefined;
  } catch {
    // Host unreachable / relation lookup failed: only a body-declared link is
    // a known (now unavailable) source; otherwise there is nothing to report.
    return issueNumber == null ? undefined : { status: 'unavailable', ref: `#${issueNumber}` };
  }
  if (issueNumber == null) return undefined;
  const issueRef = `#${issueNumber}`;
  try {
    const meta = await host.getIssue(ref, issueNumber);
    return meta
      ? { status: 'fetched', ref: issueRef, title: meta.title, body: meta.body ?? null }
      : { status: 'unavailable', ref: issueRef };
  } catch {
    return { status: 'unavailable', ref: issueRef };
  }
}

/**
 * The ref handed to `HostGitClient.readFile`: always the full host-aware ref
 * (provider/host/fullName) so the adapter resolves the right clone directory —
 * for GitHub that is the same `<cloneDir>/<owner>/<repo>` it always was.
 */
export function gitRepoRef(repo: LinkedIssueRepo): HostRepoRef {
  return toHostRef(repo);
}
