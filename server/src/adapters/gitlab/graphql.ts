/**
 * gitlab.com GraphQL documents used by the PR-list sync. Kept in ONE file so a
 * vendor shape change is a single edit (plan risk "diffStatsSummary shape").
 *
 * Verified against docs.gitlab.com/api/graphql/reference (2026-10-16):
 *  - `Project.mergeRequests(state, iids, first ≤ 100, after)` → MergeRequestConnection;
 *  - `MergeRequest.diffStatsSummary` → `DiffStatsSummary { additions deletions changes fileCount }`
 *    (nullable — missing ⇒ `stats_known:false`, never 0);
 *  - `MergeRequest.iid` is a `String!`; `state` ∈ opened|closed|locked|merged;
 *  - `state: opened` also returns `locked` MRs (GitLab's `opened` scope);
 *  - sorted `CREATED_ASC` so an MR updated mid-walk cannot shift between pages.
 * GitLab's capped string `changes_count` is intentionally NOT queried (AC-20).
 */

export const GITLAB_PAGE_SIZE = 100;

export const OPEN_MERGE_REQUESTS_QUERY = `
query DevDigestOpenMergeRequests($fullPath: ID!, $first: Int!, $after: String) {
  project(fullPath: $fullPath) {
    mergeRequests(state: opened, first: $first, after: $after, sort: CREATED_ASC) {
      pageInfo { hasNextPage endCursor }
      nodes {
        iid
        title
        draft
        state
        sourceBranch
        targetBranch
        diffHeadSha
        createdAt
        updatedAt
        author { username }
        diffStatsSummary { additions deletions fileCount }
      }
    }
  }
}`;

export const MERGE_REQUEST_STATES_QUERY = `
query DevDigestMergeRequestStates($fullPath: ID!, $iids: [String!], $first: Int!) {
  project(fullPath: $fullPath) {
    mergeRequests(iids: $iids, first: $first) {
      nodes { iid state }
    }
  }
}`;

/**
 * Exact stats for ONE MR — used by the PR-page detail fetch only when a file's
 * patch was withheld (`too_large`/`collapsed`), so per-file line counts cannot
 * be derived from the REST diffs.
 */
export const MERGE_REQUEST_STATS_QUERY = `
query DevDigestMergeRequestStats($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) {
    mergeRequest(iid: $iid) {
      diffStatsSummary { additions deletions fileCount }
    }
  }
}`;

// ---------- vendor shapes (only the fields we query) ----------
export interface GqlDiffStatsSummary {
  additions?: number | null;
  deletions?: number | null;
  fileCount?: number | null;
}

export interface GqlMergeRequestNode {
  iid: string;
  title?: string | null;
  draft?: boolean | null;
  state?: string | null;
  sourceBranch?: string | null;
  targetBranch?: string | null;
  diffHeadSha?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  author?: { username?: string | null } | null;
  diffStatsSummary?: GqlDiffStatsSummary | null;
}

export interface GqlOpenMergeRequestsData {
  project: {
    mergeRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: (GqlMergeRequestNode | null)[];
    } | null;
  } | null;
}

export interface GqlMergeRequestStatesData {
  project: {
    mergeRequests: { nodes: ({ iid: string; state: string | null } | null)[] } | null;
  } | null;
}

export interface GqlMergeRequestStatsData {
  project: { mergeRequest: { diffStatsSummary: GqlDiffStatsSummary | null } | null } | null;
}
