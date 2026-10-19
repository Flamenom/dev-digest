import type { Container } from '../../platform/container.js';
import type { UnifiedDiff } from '@devdigest/shared';
import { parseUnifiedDiff } from '../../adapters/git/diff-parser.js';
import { hostRepoRef, type RepoIdentityRow } from '../_shared/repo-ref.js';
import type { ReviewRepository, PullRow } from './repository.js';

/** Where the review diff came from: a real local `git diff`, or the pr_files rebuild. */
export type DiffSource = 'local' | 'fallback';

export interface LoadedDiff {
  diff: UnifiedDiff;
  source: DiffSource;
  /**
   * Files the host omitted a patch for (`pr_files.patch_omitted`: too large /
   * collapsed) and that are therefore NOT in the fallback diff (AC-31). Always 0
   * for a local diff — the local clone has every file.
   */
  excludedFiles: number;
}

/**
 * Load the unified diff for a PR/MR. Prefers a real `git diff base...head`
 * from the local clone; falls back to assembling a synthetic unified diff from
 * the persisted pr_files patches (so the reviewer works even before a clone
 * completes / in tests).
 *
 * GitLab (AC-29/AC-30): the MR head is fetched from the TARGET project's
 * `refs/merge-requests/<iid>/head` (works for fork MRs without fork access),
 * best-effort; the diff is then taken against `origin/<base>`. GitHub is
 * unchanged.
 */
export async function loadDiff(
  container: Container,
  repo: ReviewRepository,
  _workspaceId: string,
  pull: PullRow,
  repoRow: RepoIdentityRow,
): Promise<LoadedDiff> {
  const ref = hostRepoRef(repoRow);
  try {
    let base = pull.base;
    if (ref.provider === 'gitlab') {
      // Best-effort: a failed fetch (offline, ref gone) leaves the diff below
      // to fail → pr_files fallback.
      await container.git
        .fetchPullHead(ref, pull.number, { base: pull.base })
        .catch(() => undefined);
      base = `origin/${pull.base}`;
    }
    const diff = await container.git.diff(ref, base, pull.headSha);
    if (diff.files.length > 0) return { diff, source: 'local', excludedFiles: 0 };
  } catch {
    /* fall through to pr_files reconstruction */
  }
  const files = await repo.getPrFiles(pull.id);
  return {
    diff: buildDiffFromFiles(files),
    source: 'fallback',
    excludedFiles: files.filter((f) => f.patchOmitted != null).length,
  };
}

/** Reconstruct a UnifiedDiff from persisted pr_files patches. */
export async function diffFromPrFiles(repo: ReviewRepository, prId: string): Promise<UnifiedDiff> {
  return buildDiffFromFiles(await repo.getPrFiles(prId));
}

/**
 * Host-omitted files (`patchOmitted` set) and patch-less files (binary) are
 * skipped. Deleted files keep only `-` lines → no new-side line numbers, so
 * the grounding gate rejects any finding on them (AC-33).
 */
function buildDiffFromFiles(
  files: { path: string; patch: string | null; patchOmitted?: string | null }[],
): UnifiedDiff {
  const parts: string[] = [];
  for (const f of files) {
    if (!f.patch || f.patchOmitted != null) continue;
    parts.push(`diff --git a/${f.path} b/${f.path}`);
    parts.push(`--- a/${f.path}`);
    parts.push(`+++ b/${f.path}`);
    parts.push(f.patch);
  }
  return parseUnifiedDiff(parts.join('\n'));
}
