import {
  PrFileChangeType,
  PrPatchOmitted,
  type PrCommit,
  type PrDetail,
  type PrDetailHost,
  type PrFileHost,
  type PrMetaHost,
  type PullRequestHost,
  type RepoProvider,
} from '@devdigest/shared';
import { AppError } from '../../platform/errors.js';
import { hostRepoRef, type RepoIdentityRow } from '../_shared/repo-ref.js';
import type { PersistedCommit, PersistedFile, PullRequestStore } from './repository.js';
import type { SyncLogger } from './sync-service.js';

/** The persisted PR fields a detail read needs (structural — a `pull_requests` row satisfies it). */
export interface DetailPr {
  id: string;
  workspaceId: string;
  repoId: string;
  number: number;
  title: string;
  author: string;
  branch: string;
  base: string;
  headSha: string;
  additions: number;
  deletions: number;
  filesCount: number;
  status: string;
  openedAt: Date | null;
  updatedAt: Date | null;
  body: string | null;
  isDraft: boolean | null;
  statsKnown: boolean | null;
  /** Head SHA the persisted files/commits were fetched at (GitLab only). */
  detailHeadSha: string | null;
}

/** The repo fields a detail read needs (structural — a `repos` row satisfies it). */
export type DetailRepo = RepoIdentityRow;

/**
 * Consumer-shaped logger (pino satisfies it incidentally) — the same shape as
 * the list sync's. Passed per call so warnings carry the request's log context
 * (reqId), not the app logger's.
 */
export type DetailLogger = SyncLogger;

export interface PullDetailDeps {
  /** Host client for a provider; rejects when that provider is unavailable (no token / offline). */
  hosts: (provider: RepoProvider) => Promise<PullRequestHost>;
  /** `pull_requests` writes + the persisted files/commits read. */
  store: PullRequestStore;
}

/**
 * The PR-detail use case as consumers see it — the container's override slot
 * and getter are typed by this (a class with private members is nominal, so a
 * plain-object test fake could not satisfy the class type).
 */
export interface PullDetail {
  refresh(pr: DetailPr, repo: DetailRepo, log?: DetailLogger): Promise<PrDetailHost>;
  isReadOnly(repo: DetailRepo): boolean;
  assertWritable(repo: DetailRepo): void;
}

/**
 * PR/MR detail (`GET /pulls/:id`) — the only place diffs, patches and commits
 * are fetched from a host.
 *
 * - GitHub: always a full refetch + replace of the mirrored files/commits
 *   (unchanged behaviour, AC-48).
 * - GitLab: refetch ONLY when the host head moved since the persisted detail
 *   (`detail_head_sha`, Q6). An unchanged head refreshes metadata only and
 *   serves the persisted files/commits.
 * - Any host failure → the persisted detail (AC-26).
 */
export class PullDetailService implements PullDetail {
  constructor(private deps: PullDetailDeps) {}

  /** true ⇒ the repo's host has no write path in the MVP (GitLab). */
  isReadOnly(repo: DetailRepo): boolean {
    return hostRepoRef(repo).provider === 'gitlab';
  }

  /** Rejects writes (comments) on a read-only host — before any client is resolved (AC-44). */
  assertWritable(repo: DetailRepo): void {
    if (this.isReadOnly(repo)) {
      throw new AppError('provider_read_only', 'Posting to GitLab is not supported yet.', 400);
    }
  }

  async refresh(pr: DetailPr, repo: DetailRepo, log?: DetailLogger): Promise<PrDetailHost> {
    const ref = hostRepoRef(repo);
    if (ref.provider === 'gitlab') return this.refreshGitLab(pr, repo, log);

    // GitHub — the pre-GitLab always-full path.
    try {
      const host = await this.deps.hosts('github');
      const result = await host.getPullRequestDetail(ref, pr.number);
      if (result.kind !== 'full') throw new Error('GitHub host returned no detail');
      const detail = result.detail;
      // Replace-in-place of the mirrored files/commits + metadata in ONE
      // transaction (see `PullRequestRepository.replaceDetail`): without it a
      // failure between delete and insert leaves the PR with NO diff.
      await this.deps.store.replaceDetail(pr.workspaceId, pr.id, detail, null);
      return { ...detail, id: pr.id };
    } catch (err) {
      log?.warn(
        { err },
        'GitHub PR detail refresh skipped (no token / offline); serving persisted detail',
      );
      return this.persistedGitHub(pr);
    }
  }

  private async refreshGitLab(
    pr: DetailPr,
    repo: DetailRepo,
    log?: DetailLogger,
  ): Promise<PrDetailHost> {
    const ref = hostRepoRef(repo);
    try {
      const host = await this.deps.hosts('gitlab');
      const result = await host.getPullRequestDetail(ref, pr.number, {
        unlessHeadSha: pr.detailHeadSha,
      });
      if (result.kind === 'full') {
        const detail = result.detail;
        await this.deps.store.replaceDetail(pr.workspaceId, pr.id, detail, {
          isDraft: detail.is_draft ?? null,
          detailHeadSha: detail.head_sha,
        });
        return {
          ...detail,
          id: pr.id,
          files_omitted_by_host:
            detail.files_omitted_by_host ?? detail.files.filter((f) => f.patch_omitted).length,
        };
      }
      // Head unchanged: refresh metadata only. `meta.stats_known:false` ⇒ the
      // upsert keeps the persisted stats (never overwrites them with zeros).
      const meta = result.meta;
      await this.deps.store.upsertListWithStats(
        { workspaceId: pr.workspaceId, repoId: pr.repoId },
        [meta],
      );
      return this.persistedGitLab(pr, meta);
    } catch (err) {
      log?.warn(
        { err },
        'GitLab MR detail refresh skipped (offline / host error); serving persisted detail',
      );
      return this.persistedGitLab(pr, null);
    }
  }

  /** Persisted detail, field-identical to the pre-GitLab GitHub fallback (AC-48). */
  private async persistedGitHub(pr: DetailPr): Promise<PrDetail> {
    const { files, commits } = await this.deps.store.getPersistedDetail(pr.id);
    return {
      ...baseMeta(pr),
      body: pr.body ?? null,
      files: files.map((f) => ({
        path: f.path,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ?? null,
      })),
      commits: commits.map(toCommit),
    };
  }

  /** Persisted GitLab detail; `meta` (fresh host metadata) overrides the stored row when given. */
  private async persistedGitLab(pr: DetailPr, meta: PrMetaHost | null): Promise<PrDetailHost> {
    const { files, commits } = await this.deps.store.getPersistedDetail(pr.id);
    const mapped = files.map(toHostFile);
    const statsFromMeta = meta != null && meta.stats_known !== false;
    const isDraft = meta?.is_draft ?? pr.isDraft;
    const statsKnown = statsFromMeta || pr.statsKnown === true;
    return {
      ...baseMeta(pr),
      ...(meta
        ? {
            title: meta.title,
            head_sha: meta.head_sha,
            status: meta.status,
            updated_at: meta.updated_at ?? null,
          }
        : {}),
      ...(statsFromMeta
        ? { additions: meta.additions, deletions: meta.deletions, files_count: meta.files_count }
        : {}),
      body: pr.body ?? null,
      files: mapped,
      commits: commits.map(toCommit),
      ...(isDraft != null ? { is_draft: isDraft } : {}),
      stats_known: statsKnown,
      files_omitted_by_host: mapped.filter((f) => f.patch_omitted).length,
    };
  }
}

function baseMeta(pr: DetailPr) {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    author: pr.author,
    branch: pr.branch,
    base: pr.base,
    head_sha: pr.headSha,
    additions: pr.additions,
    deletions: pr.deletions,
    files_count: pr.filesCount,
    status: pr.status as PrDetail['status'],
    opened_at: pr.openedAt?.toISOString() ?? null,
    updated_at: pr.updatedAt?.toISOString() ?? null,
  };
}

function toCommit(c: PersistedCommit): PrCommit {
  return {
    sha: c.sha,
    message: c.message,
    author: c.author,
    committed_at: c.committedAt?.toISOString() ?? null,
  };
}

function toHostFile(f: PersistedFile): PrFileHost {
  const changeType = PrFileChangeType.safeParse(f.changeType);
  const omitted = PrPatchOmitted.safeParse(f.patchOmitted);
  return {
    path: f.path,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch ?? null,
    previous_path: f.previousPath ?? null,
    ...(changeType.success ? { change_type: changeType.data } : {}),
    patch_omitted: omitted.success ? omitted.data : null,
  };
}
