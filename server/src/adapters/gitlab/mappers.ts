import type {
  GitLabProjectInfo,
  IssueMetaHost,
  PrCommit,
  PrFileHost,
  PrMetaHost,
  PrStatus,
} from '@devdigest/shared';
import type { GqlDiffStatsSummary, GqlMergeRequestNode } from './graphql.js';

/**
 * Anti-corruption layer: gitlab.com vendor shapes → DevDigest domain contracts.
 * Pure functions, no I/O. Everything read here is untrusted host data; it is
 * only reshaped (never interpreted), and length/shape guards keep a malformed
 * payload from producing an invalid domain object.
 */

// ---------- REST vendor shapes (only the fields we read) ----------
export interface RestMergeRequest {
  iid: number;
  project_id?: number;
  title?: string | null;
  description?: string | null;
  state?: string | null;
  draft?: boolean | null;
  work_in_progress?: boolean | null;
  source_branch?: string | null;
  target_branch?: string | null;
  sha?: string | null;
  diff_refs?: { head_sha?: string | null } | null;
  author?: { username?: string | null } | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface RestDiff {
  old_path?: string | null;
  new_path?: string | null;
  diff?: string | null;
  new_file?: boolean | null;
  renamed_file?: boolean | null;
  deleted_file?: boolean | null;
  too_large?: boolean | null;
  collapsed?: boolean | null;
}

export interface RestCommit {
  id: string;
  title?: string | null;
  message?: string | null;
  author_name?: string | null;
  committed_date?: string | null;
}

export interface RestIssue {
  iid: number;
  project_id?: number;
  title?: string | null;
  description?: string | null;
  state?: string | null;
  labels?: unknown;
}

export interface RestProject {
  id: number;
  path_with_namespace: string;
  default_branch?: string | null;
  web_url?: string | null;
}

export interface RestUser {
  username?: string | null;
}

export interface RestTokenSelf {
  scopes?: unknown;
}

// ---------- state ----------
/** AC-19: opened|locked → open, merged → merged, closed → closed. */
export function mapMrState(state: string | null | undefined): PrStatus {
  switch ((state ?? '').toLowerCase()) {
    case 'merged':
      return 'merged';
    case 'closed':
      return 'closed';
    case 'opened':
    case 'locked':
    default:
      return 'open';
  }
}

// ---------- stats ----------
export interface MrStats {
  additions: number;
  deletions: number;
  files_count: number;
  stats_known: boolean;
}

const nonNegInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;

/**
 * `diffStatsSummary` → stats. A null/partial summary ⇒ `stats_known:false` with
 * zeros (AC-54: shown as "—", never 0). `changes_count` is never used (AC-20).
 */
export function mapDiffStats(summary: GqlDiffStatsSummary | null | undefined): MrStats {
  const additions = nonNegInt(summary?.additions);
  const deletions = nonNegInt(summary?.deletions);
  const files = nonNegInt(summary?.fileCount);
  if (additions === null || deletions === null || files === null) {
    return { additions: 0, deletions: 0, files_count: 0, stats_known: false };
  }
  return { additions, deletions, files_count: files, stats_known: true };
}

const UNKNOWN_STATS: MrStats = { additions: 0, deletions: 0, files_count: 0, stats_known: false };

// ---------- merge requests ----------
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** GraphQL list node → PR meta (one node already carries metadata + stats). */
export function mapGqlMergeRequest(node: GqlMergeRequestNode): PrMetaHost | null {
  const number = Number(node.iid);
  if (!Number.isInteger(number) || number <= 0) return null;
  const stats = mapDiffStats(node.diffStatsSummary);
  return {
    number,
    title: str(node.title),
    author: str(node.author?.username, 'unknown') || 'unknown',
    branch: str(node.sourceBranch),
    base: str(node.targetBranch),
    // GraphQL exposes no `sha` on MergeRequest; a missing diffHeadSha ⇒ ''.
    head_sha: str(node.diffHeadSha),
    additions: stats.additions,
    deletions: stats.deletions,
    files_count: stats.files_count,
    stats_known: stats.stats_known,
    status: mapMrState(node.state),
    is_draft: node.draft === true,
    opened_at: strOrNull(node.createdAt),
    updated_at: strOrNull(node.updatedAt),
  };
}

/** REST MR head SHA: `sha`, then `diff_refs.head_sha`, else ''. */
export function restHeadSha(mr: RestMergeRequest): string {
  return str(mr.sha) || str(mr.diff_refs?.head_sha) || '';
}

/** REST MR → PR meta. REST carries no line stats; pass them when known. */
export function mapRestMergeRequestMeta(mr: RestMergeRequest, stats: MrStats = UNKNOWN_STATS): PrMetaHost {
  return {
    number: mr.iid,
    title: str(mr.title),
    author: str(mr.author?.username, 'unknown') || 'unknown',
    branch: str(mr.source_branch),
    base: str(mr.target_branch),
    head_sha: restHeadSha(mr),
    additions: stats.additions,
    deletions: stats.deletions,
    files_count: stats.files_count,
    stats_known: stats.stats_known,
    status: mapMrState(mr.state),
    is_draft: mr.draft === true || mr.work_in_progress === true,
    opened_at: strOrNull(mr.created_at),
    updated_at: strOrNull(mr.updated_at),
  };
}

// ---------- files ----------
/** Count +/- lines inside hunks of a GitLab (header-less) diff. */
export function countDiffLines(diff: string | null | undefined): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  if (!diff) return { additions, deletions };
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

/**
 * REST diff entry → file. `new_file→added`, `deleted_file→deleted`,
 * `renamed_file→renamed` (+ `previous_path` = `old_path`); `too_large` /
 * `collapsed` → `patch_omitted` with `patch:null` (AC-24/33).
 */
export function mapRestDiff(d: RestDiff): PrFileHost {
  const path = str(d.new_path) || str(d.old_path);
  const omitted = d.too_large ? 'too_large' : d.collapsed ? 'collapsed' : null;
  const patch = omitted ? null : strOrNull(d.diff);
  const { additions, deletions } = countDiffLines(patch);
  const change_type = d.new_file
    ? 'added'
    : d.deleted_file
      ? 'deleted'
      : d.renamed_file
        ? 'renamed'
        : 'modified';
  return {
    path,
    additions,
    deletions,
    patch,
    change_type,
    previous_path: change_type === 'renamed' ? strOrNull(d.old_path) : null,
    patch_omitted: omitted,
  };
}

// ---------- commits ----------
export function mapRestCommit(c: RestCommit): PrCommit {
  return {
    sha: str(c.id),
    message: str(c.message) || str(c.title),
    author: str(c.author_name, 'unknown') || 'unknown',
    committed_at: strOrNull(c.committed_date),
  };
}

// ---------- issues ----------
/** GitLab `opened` → `open` (same vocabulary as GitHub issues). */
export function mapRestIssue(issue: RestIssue): IssueMetaHost {
  const labels = Array.isArray(issue.labels)
    ? issue.labels.filter((l): l is string => typeof l === 'string')
    : [];
  const state = str(issue.state);
  return {
    number: issue.iid,
    title: str(issue.title),
    body: issue.description ?? null,
    state: state === 'opened' ? 'open' : state || 'open',
    labels,
  };
}

// ---------- project ----------
export function mapRestProject(p: RestProject): GitLabProjectInfo {
  return {
    id: p.id,
    fullPath: p.path_with_namespace,
    defaultBranch: str(p.default_branch, 'main') || 'main',
    webUrl: str(p.web_url),
  };
}

// ---------- token ----------
/** Scopes the MVP needs; `api` is a superset of both. */
export const GITLAB_REQUIRED_SCOPES = ['read_api', 'read_repository'] as const;

export function missingScopes(scopes: string[]): string[] {
  if (scopes.includes('api')) return [];
  return GITLAB_REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
}

/** 401 body (`error_description`) → failure reason. The text itself is never echoed. */
export function tokenFailureReason(detail: string | null | undefined): 'invalid' | 'expired' | 'revoked' {
  const d = (detail ?? '').toLowerCase();
  if (d.includes('expired')) return 'expired';
  if (d.includes('revoked')) return 'revoked';
  return 'invalid';
}
