import {
  HostCommentErrorCode,
  HostErrorCode,
  type PullRequestHost,
  type RepoProvider,
} from '@devdigest/shared';
import { hostRepoRef, type RepoIdentityRow } from '../_shared/repo-ref.js';
import { redactSecret } from '../../platform/redact.js';
import type { PullRequestStore } from './repository.js';

/** The repo fields a PR-list sync needs (structural — a `repos` row satisfies it). */
export interface SyncRepo extends RepoIdentityRow {
  id: string;
  workspaceId: string;
}

/**
 * Consumer-shaped logger (pino satisfies it incidentally). `child` is optional
 * so a bare `{ warn }` fake still fits; when present the composition root uses
 * it to tag detached sync logs with their module.
 */
export interface SyncLogger {
  warn: (obj: unknown, msg?: string) => void;
  child?: (bindings: Record<string, unknown>) => SyncLogger;
}

const MAX_ERROR_LENGTH = 500;

/** The host error code of `err` (matched by shape), or null when it is not a known host code. */
function hostErrorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return null;
  return HostErrorCode.safeParse(code).success || HostCommentErrorCode.safeParse(code).success
    ? code
    : null;
}

/**
 * Any sync failure → a redacted, single-line, ≤ 500-char message. Host errors
 * can echo request URLs/headers, so a raw error object is NEVER handed to a
 * logger or persisted — always this string.
 *
 * A known host error code (`HostErrorCode` ∪ `HostCommentErrorCode`, e.g.
 * `gitlab_token_insufficient_scope` from the token gate) is kept as a
 * `[<code>] ` prefix so the recorded failure names it (spec 2026-10-20 AC-23).
 */
export function describeSyncError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const code = hostErrorCode(err);
  const message = redactSecret(raw).replace(/\s+/g, ' ').trim() || 'PR sync failed';
  const oneLine = code ? `[${code}] ${message}` : message;
  return oneLine.length > MAX_ERROR_LENGTH ? `${oneLine.slice(0, MAX_ERROR_LENGTH - 1)}…` : oneLine;
}

export interface PrListSyncDeps {
  /** Host client for a provider; rejects when that provider is unavailable (e.g. no token). */
  hosts: (provider: RepoProvider) => Promise<PullRequestHost>;
  store: PullRequestStore;
  log?: SyncLogger;
}

/** GitHub list payloads carry no diff stats; backfill at most this many per sync. */
export const GITHUB_BACKFILL_LIMIT = 10;

/**
 * One PR-list sync for one repo, against THAT repo's provider only (AC-27): a
 * failing GitHub client never touches a GitLab repo's sync and vice versa.
 * Every host call is awaited before the next — at most ONE host request in
 * flight per sync. Throws when the sync failed (the coordinator records it).
 *
 * - GitHub: list → `upsertList` (unchanged rule) → sequential backfill of
 *   ≤ {@link GITHUB_BACKFILL_LIMIT} zero-stat PRs from the detail endpoint
 *   (one failure skips only that PR, as before).
 * - GitLab: list (metadata + batched stats, never diffs — AC-18/20) →
 *   `upsertListWithStats` → reconcile MRs that left the open set via
 *   `getPullStates` → `updateStatuses` (AC-28).
 */
export class PrListSyncService {
  constructor(private deps: PrListSyncDeps) {}

  async syncRepo(repo: SyncRepo): Promise<void> {
    const ref = hostRepoRef(repo);
    const host = await this.deps.hosts(ref.provider);
    const scope = { workspaceId: repo.workspaceId, repoId: repo.id };
    const pulls = await host.listPullRequests(ref);

    if (ref.provider === 'gitlab') {
      await this.deps.store.upsertListWithStats(scope, pulls);
      const listed = new Set(pulls.map((p) => p.number));
      const gone = (await this.deps.store.listOpenNumbers(scope)).filter((n) => !listed.has(n));
      if (gone.length > 0) {
        const states = await host.getPullStates(ref, gone);
        await this.deps.store.updateStatuses(scope, states);
      }
      return;
    }

    await this.deps.store.upsertList(scope, pulls);
    const gaps = await this.deps.store.listMissingStats(scope, GITHUB_BACKFILL_LIMIT);
    for (const gap of gaps) {
      try {
        const result = await host.getPullRequestDetail(ref, gap.number);
        const d = result.kind === 'full' ? result.detail : result.meta;
        await this.deps.store.updateDiffStats(repo.workspaceId, gap.id, {
          additions: d.additions,
          deletions: d.deletions,
          filesCount: d.files_count,
        });
      } catch (err) {
        this.deps.log?.warn(
          { err: describeSyncError(err), number: gap.number },
          'PR diff-stat backfill skipped',
        );
      }
    }
  }
}
