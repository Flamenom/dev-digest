import type { Container } from '../../platform/container.js';
import type { RepoHost, RepoProvider, RepoWithHost } from '@devdigest/shared';
import { AppError, NotFoundError } from '../../platform/errors.js';
import { redactSecret } from '../../platform/redact.js';
import { cloneRemoteUrl, hostRepoRef } from '../_shared/repo-ref.js';
import { RepoRepository, type RepoRow } from './repository.js';
import { parseGitLabPath, parseRepoUrlHost, toRepoDto } from './helpers.js';
import {
  CLONE_JOB_KIND,
  CLONE_DEPTH,
  GIT_AUTH_FAILURE_REGEX,
  GITLAB_CLONE_AUTH_MESSAGE,
} from './constants.js';
import {
  INDEX_JOB_KIND,
  REFRESH_JOB_KIND,
} from '../repo-intel/constants.js';

/**
 * F1 — repos service. Business logic for the Repositories feature:
 *   - add / list / refresh / remove
 *   - the asynchronous `clone` job (real `git clone` via the GitClient adapter)
 *
 * No HTTP and no raw SQL live here — persistence goes through RepoRepository,
 * pure transforms through helpers.ts, literals through constants.ts.
 */

/** Payload enqueued for (and consumed by) the `clone` job. */
export interface CloneJobPayload {
  repoId: string;
  owner: string;
  name: string;
  /** Missing (payloads from before GitLab support) ⇒ github. */
  provider?: RepoProvider;
  host?: RepoHost;
  /**
   * Informational, ALWAYS tokenless. The job rebuilds the remote from
   * provider + full name (`cloneRemoteUrl`) and never trusts this value.
   */
  url: string;
}

export class RepoService {
  private repo: RepoRepository;

  constructor(private container: Container) {
    this.repo = new RepoRepository(container.db);
  }

  /**
   * Register the `clone` job handler once. Clones via the GitClient adapter —
   * which supplies per-provider credentials per invocation (Q8) — then persists
   * the resulting path + last_polled_at.
   */
  registerCloneJobHandler(): void {
    this.container.jobs.register(CLONE_JOB_KIND, async (payload) => {
      await this.runCloneJob(payload as CloneJobPayload);
    });
  }

  async runCloneJob(payload: CloneJobPayload): Promise<void> {
    const { repoId, owner, name } = payload;
    const ref = hostRepoRef({
      owner,
      name,
      fullName: `${owner}/${name}`,
      provider: payload.provider,
      host: payload.host,
    });
    // Q8 — NO token handling here: the remote is tokenless and the git adapter
    // adds the provider's own credential per invocation.
    const cloneUrl = cloneRemoteUrl(ref.provider, ref.fullName);
    let path: string;
    try {
      ({ path } = await this.container.git.clone(ref, cloneUrl, { depth: CLONE_DEPTH }));
    } catch (err) {
      throw cloneError(ref.provider, err);
    }
    await this.repo.updateClonePath(repoId, path);

    // T2.2 — kick off the indexer in the background. ENQUEUE (not call) so the
    // clone job closes immediately and the (heavier) index runs as its own
    // job under JobRunner's timeout/retry. If the handler isn't registered
    // (e.g. repo-intel disabled at module wiring), enqueue() throws — log and
    // continue so the clone result is preserved either way.
    const workspaceId = await this.repo.workspaceIdFor(repoId);
    if (workspaceId) {
      try {
        await this.container.jobs.enqueue(workspaceId, INDEX_JOB_KIND, {
          repoId,
          owner,
          name,
        });
      } catch {
        // No handler registered or transient enqueue failure — clone has
        // already succeeded, so we don't fail the job for an index-followup
        // miss. The user can hit POST /repos/:id/reindex to retry.
      }
    }
  }

  /**
   * Add a repo: parse the URL, dedupe within the workspace, persist, and enqueue
   * the real clone (non-blocking). `created` is false when the repo already
   * existed (the caller returns 200 instead of 201).
   */
  async add(
    workspaceId: string,
    userId: string,
    url: string,
  ): Promise<{ repo: RepoWithHost; created: boolean }> {
    // Pure validation first: an unsupported host / unsafe path never reaches the
    // network (AC-9/AC-10).
    let parsed = parseRepoUrlHost(url);

    const existing = await this.repo.findByIdentity(workspaceId, parsed);
    if (existing) return { repo: toRepoDto(existing), created: false };

    let defaultBranch: string | undefined;
    if (parsed.provider === 'gitlab') {
      // Canonical identity = gitlab.com's `path_with_namespace` (AC-52). The
      // adapter maps private/no-token → gitlab_token_missing (AC-13) and
      // token-without-access → gitlab_project_inaccessible (AC-14).
      const project = await (await this.container.gitlab()).getProject(parsed.fullName);
      parsed = parseGitLabPath(project.fullPath);
      defaultBranch = project.defaultBranch || undefined;
      const canonical = await this.repo.findByIdentity(workspaceId, parsed);
      if (canonical) return { repo: toRepoDto(canonical), created: false };
    }

    const row = await this.repo.insert({
      workspaceId,
      owner: parsed.owner,
      name: parsed.name,
      fullName: parsed.fullName,
      provider: parsed.provider,
      host: parsed.host,
      defaultBranch,
      createdBy: userId,
    });
    if (!row) {
      // Lost a concurrent-add race on the identity unique index.
      const winner = await this.repo.findByIdentity(workspaceId, parsed);
      if (winner) return { repo: toRepoDto(winner), created: false };
      throw new AppError('repo_conflict', 'Repository could not be added; try again', 409);
    }
    await this.enqueueClone(workspaceId, row);
    return { repo: toRepoDto(row), created: true };
  }

  async list(workspaceId: string): Promise<RepoWithHost[]> {
    const rows = await this.repo.list(workspaceId);
    // `running` lives only in the in-memory sync coordinator (never persisted).
    const prSync = this.container.prSync;
    return rows.map((row) => toRepoDto(row, { syncRunning: prSync.isRunning(row.id) }));
  }

  /** Enqueue the clone job; the remote is rebuilt from the stored identity (AC-17). */
  private async enqueueClone(workspaceId: string, row: RepoRow): Promise<void> {
    const ref = hostRepoRef(row);
    await this.container.jobs.enqueue(workspaceId, CLONE_JOB_KIND, {
      repoId: row.id,
      owner: ref.owner,
      name: ref.name,
      provider: ref.provider,
      host: ref.host,
      url: cloneRemoteUrl(ref.provider, ref.fullName),
    } satisfies CloneJobPayload);
  }

  /** Re-fetch the clone for an existing repo (enqueues a fresh `clone` job). */
  async refresh(workspaceId: string, id: string): Promise<{ status: 'refreshing' }> {
    const repo = await this.repo.getById(workspaceId, id);
    if (!repo) throw new NotFoundError('Repo not found');
    await this.enqueueClone(workspaceId, repo);
    // T2.2 — also enqueue an incremental refresh. The two queue positions are
    // independent (p-queue doesn't FIFO across kinds), but `runIncremental` is
    // a no-op when `currentHead === lastIndexedSha`, so ordering is safe: if
    // refresh fires before the new clone settles, it cheaply exits; if after,
    // it picks up the new HEAD.
    try {
      await this.container.jobs.enqueue(workspaceId, REFRESH_JOB_KIND, {
        repoId: repo.id,
        owner: repo.owner,
        name: repo.name,
      });
    } catch {
      // No handler / transient enqueue failure — refresh button is best-effort.
    }
    return { status: 'refreshing' };
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const ok = await this.repo.remove(workspaceId, id);
    if (!ok) throw new NotFoundError('Repo not found');
  }
}

/**
 * Clone failures: for GitLab, an auth-shaped failure becomes the actionable
 * "connect a GitLab token" hint (AC-12/13). Every message is redacted — the
 * adapter already masks the token, this strips any stray userinfo too.
 */
function cloneError(provider: RepoProvider, err: unknown): Error {
  const message = redactSecret(err instanceof Error ? err.message : String(err));
  if (provider === 'gitlab' && GIT_AUTH_FAILURE_REGEX.test(message)) {
    return new AppError('gitlab_token_missing', GITLAB_CLONE_AUTH_MESSAGE, 400, { cause: message });
  }
  const out = new Error(message);
  out.name = err instanceof Error ? err.name : 'GitError';
  return out;
}
