import type {
  GitHubClient,
  HostRepoRef,
  IssueMetaHost,
  PrMetaHost,
  PullDetailResult,
  PullRequestHost,
  PullStateInfo,
} from '@devdigest/shared';

/**
 * Read-side `PullRequestHost` for GitHub — pure delegation to the existing
 * `GitHubClient`, with NO behaviour change (spec: GitHub flows are untouched).
 *
 *  - The GitHub list is fetched with `state=all`, so there is nothing to
 *    reconcile → `getPullStates` returns `[]`.
 *  - There is no cheap head-SHA short-circuit on GitHub → detail is always `full`.
 *  - Linked-issue derivation stays where it is today (intent/brief); the host
 *    answers `null` for `getIssue` / `getLinkedIssueNumber`.
 *  - GitHub keeps its write paths (comments, reviews) → `readOnly: false`.
 */
export class GitHubPullRequestHost implements PullRequestHost {
  readonly provider = 'github' as const;
  readonly readOnly = false;

  constructor(private readonly gh: GitHubClient) {}

  listPullRequests(ref: HostRepoRef): Promise<PrMetaHost[]> {
    return this.gh.listPullRequests(ref);
  }

  async getPullStates(_ref: HostRepoRef, _numbers: number[]): Promise<PullStateInfo[]> {
    return [];
  }

  async getPullRequestDetail(ref: HostRepoRef, n: number): Promise<PullDetailResult> {
    return { kind: 'full', detail: await this.gh.getPullRequest(ref, n) };
  }

  async getIssue(_ref: HostRepoRef, _n: number): Promise<IssueMetaHost | null> {
    return null;
  }

  async getLinkedIssueNumber(_ref: HostRepoRef, _n: number): Promise<number | null> {
    return null;
  }
}
