import { describe, it, expect } from 'vitest';
import type { Finding, RepoRef, UnifiedDiff } from '@devdigest/shared';
import { groundFindings } from '@devdigest/reviewer-core';
import { loadDiff } from '../src/modules/reviews/diff-loader.js';
import type { ReviewRepository, PullRow } from '../src/modules/reviews/repository.js';
import type { Container } from '../src/platform/container.js';
import { MockGitClient } from '../src/adapters/mocks.js';

/**
 * Hermetic diff-loader tests for GitLab MRs (AC-29/AC-30/AC-31/AC-33). The git
 * port is MockGitClient (records `pullHeadFetches`); the repository is a
 * pr_files-only fake. No DB, no network.
 */

type PrFile = {
  path: string;
  patch: string | null;
  patchOmitted: string | null;
  changeType?: string | null;
  previousPath?: string | null;
};

const MODIFIED_PATCH = '@@ -1,2 +1,3 @@\n line one\n+added line\n line two';
const DELETED_PATCH = '@@ -1,3 +0,0 @@\n-gone 1\n-gone 2\n-gone 3';

function pull(): PullRow {
  return {
    id: 'pr-1',
    workspaceId: 'ws-1',
    repoId: 'repo-1',
    number: 17,
    base: 'main',
    headSha: 'cafebabe',
  } as PullRow;
}

const gitlabRepo = {
  owner: 'group/sub',
  name: 'project',
  fullName: 'group/sub/project',
  provider: 'gitlab',
  host: 'gitlab.com',
};
const githubRepo = { owner: 'acme', name: 'widgets', fullName: 'acme/widgets' };

function repoFake(files: PrFile[]): ReviewRepository {
  return { getPrFiles: async () => files } as unknown as ReviewRepository;
}

/** MockGitClient that records diff args, optionally failing the local diff. */
class RecordingGit extends MockGitClient {
  public diffCalls: { repo: RepoRef; base: string; head: string }[] = [];
  constructor(
    private readonly failDiff = false,
    raw?: string,
  ) {
    super(raw ? { diff: raw } : {});
  }
  override async diff(repo?: RepoRef, base?: string, head?: string): Promise<UnifiedDiff> {
    this.diffCalls.push({ repo: repo!, base: base!, head: head! });
    if (this.failDiff) throw new Error('fatal: no merge base');
    return super.diff();
  }
}

const containerWith = (git: MockGitClient) => ({ git }) as unknown as Container;

function finding(file: string, line: number): Finding {
  return {
    id: `f-${file}-${line}`,
    severity: 'WARNING',
    category: 'bug',
    title: 't',
    file,
    start_line: line,
    end_line: line,
    rationale: 'r',
    suggestion: null,
    confidence: 0.9,
  };
}

describe('loadDiff — GitLab merge requests', () => {
  it('fetches the MR head ref (gitlab provider) and diffs origin/<base>...head locally (AC-29/AC-30)', async () => {
    const git = new RecordingGit();
    const result = await loadDiff(containerWith(git), repoFake([]), 'ws-1', pull(), gitlabRepo);

    expect(git.pullHeadFetches).toHaveLength(1);
    expect(git.pullHeadFetches[0]!.n).toBe(17);
    expect(git.pullHeadFetches[0]!.repo).toMatchObject({ provider: 'gitlab', fullName: 'group/sub/project' });
    expect(git.diffCalls[0]).toMatchObject({ base: 'origin/main', head: 'cafebabe' });
    expect(result.source).toBe('local');
    expect(result.excludedFiles).toBe(0);
    expect(result.diff.files.length).toBeGreaterThan(0);
  });

  it('GitHub path is unchanged: no MR fetch, diff against the bare base branch', async () => {
    const git = new RecordingGit();
    const result = await loadDiff(containerWith(git), repoFake([]), 'ws-1', pull(), githubRepo);

    expect(git.pullHeadFetches).toHaveLength(0);
    expect(git.diffCalls[0]).toMatchObject({ base: 'main', head: 'cafebabe' });
    expect(git.diffCalls[0]!.repo).toMatchObject({ owner: 'acme', name: 'widgets', provider: 'github' });
    expect(result.source).toBe('local');
  });

  it('falls back to pr_files, excluding host-omitted files and counting them (AC-31)', async () => {
    const git = new RecordingGit(true);
    const files: PrFile[] = [
      { path: 'src/a.ts', patch: MODIFIED_PATCH, patchOmitted: null },
      { path: 'big/one.json', patch: null, patchOmitted: 'too_large' },
      { path: 'big/two.json', patch: null, patchOmitted: 'too_large' },
    ];
    const result = await loadDiff(containerWith(git), repoFake(files), 'ws-1', pull(), gitlabRepo);

    expect(result.source).toBe('fallback');
    expect(result.excludedFiles).toBe(2);
    expect(result.diff.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('records the reviewed head SHA: local → the diffed PR head (AC-1)', async () => {
    const result = await loadDiff(containerWith(new RecordingGit()), repoFake([]), 'ws-1', pull(), gitlabRepo);
    expect(result.source).toBe('local');
    expect(result.headSha).toBe('cafebabe');
  });

  it('records the reviewed head SHA: fallback → detail_head_sha, null when unknown (AC-1, Q7)', async () => {
    const files: PrFile[] = [{ path: 'src/a.ts', patch: MODIFIED_PATCH, patchOmitted: null }];
    const withDetail = { ...pull(), detailHeadSha: 'deadbeef' } as PullRow;
    const fb = await loadDiff(containerWith(new RecordingGit(true)), repoFake(files), 'ws-1', withDetail, gitlabRepo);
    expect(fb.source).toBe('fallback');
    expect(fb.headSha).toBe('deadbeef');

    const noDetail = { ...pull(), detailHeadSha: null } as PullRow;
    const fbNull = await loadDiff(containerWith(new RecordingGit(true)), repoFake(files), 'ws-1', noDetail, gitlabRepo);
    expect(fbNull.headSha).toBeNull();
  });

  it('a failed MR-head fetch is best-effort: the run still gets a diff', async () => {
    const git = new RecordingGit();
    git.fetchPullHead = async () => {
      throw new Error('network down');
    };
    const result = await loadDiff(containerWith(git), repoFake([]), 'ws-1', pull(), gitlabRepo);
    expect(result.source).toBe('local');
  });

  it('findings on a deleted file are dropped by grounding — local and fallback diffs (AC-33)', async () => {
    // Local git diff of a deletion: `+++ /dev/null` → the file is not a target.
    const localRaw = [
      'diff --git a/src/old.ts b/src/old.ts',
      'deleted file mode 100644',
      '--- a/src/old.ts',
      '+++ /dev/null',
      DELETED_PATCH,
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      MODIFIED_PATCH,
    ].join('\n');
    const local = await loadDiff(
      containerWith(new RecordingGit(false, localRaw)),
      repoFake([]),
      'ws-1',
      pull(),
      gitlabRepo,
    );
    expect(local.source).toBe('local');
    const localGround = groundFindings([finding('src/old.ts', 2), finding('src/a.ts', 2)], local.diff);
    expect(localGround.kept.map((f) => f.file)).toEqual(['src/a.ts']);
    expect(localGround.dropped.map((d) => d.finding.file)).toEqual(['src/old.ts']);

    // Fallback rebuild: the deleted file's patch has only `-` lines → no
    // new-side line can be cited.
    const fallback = await loadDiff(
      containerWith(new RecordingGit(true)),
      repoFake([
        { path: 'src/old.ts', patch: DELETED_PATCH, patchOmitted: null, changeType: 'deleted' },
        { path: 'src/a.ts', patch: MODIFIED_PATCH, patchOmitted: null, changeType: 'modified' },
      ]),
      'ws-1',
      pull(),
      gitlabRepo,
    );
    expect(fallback.source).toBe('fallback');
    const fbGround = groundFindings([finding('src/old.ts', 2), finding('src/a.ts', 2)], fallback.diff);
    expect(fbGround.kept.map((f) => f.file)).toEqual(['src/a.ts']);
    expect(fbGround.dropped.map((d) => d.finding.file)).toEqual(['src/old.ts']);
  });
});
