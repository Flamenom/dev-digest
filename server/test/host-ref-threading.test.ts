/**
 * T7 — HostRepoRef threading through repo-intel's GitClient call sites.
 *
 * A GitLab repo row must reach the GitClient as a host-aware ref
 * (`provider:'gitlab'`, `host:'gitlab.com'`, nested `fullName`) — never the
 * bare `{ owner, name }` literal that would silently resolve to a GitHub clone
 * path. Legacy rows without provider/host still resolve to github.com.
 *
 * Hermetic: stubbed repository (no DB), MockGitClient / spy git, tmpdir clone.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostRepoRef, RepoRef } from '@devdigest/shared';
import { RepoIntelService } from '../src/modules/repo-intel/service.js';
import { runFullIndex } from '../src/modules/repo-intel/pipeline/full.js';
import { runIncremental } from '../src/modules/repo-intel/pipeline/incremental.js';
import { MockGitClient } from '../src/adapters/mocks.js';
import { INDEXER_VERSION } from '../src/modules/repo-intel/constants.js';
import type { RepoIntelRepository } from '../src/modules/repo-intel/repository.js';
import type { IndexState } from '../src/modules/repo-intel/types.js';
import type { Container } from '../src/platform/container.js';

const GITLAB_BASICS = {
  id: 'r-gl',
  owner: 'acme/platform',
  name: 'web',
  fullName: 'acme/platform/web',
  provider: 'gitlab' as const,
  host: 'gitlab.com',
  defaultBranch: 'main',
  clonePath: '/mock/clone' as string | null,
};

function stateAt(sha: string): IndexState {
  return {
    repoId: GITLAB_BASICS.id,
    status: 'full',
    filesIndexed: 0,
    filesSkipped: 0,
    durationMs: 1,
    lastIndexedSha: sha,
    indexerVersion: INDEXER_VERSION,
    updatedAt: new Date(),
  };
}

/** Repository stub covering what resync / full / incremental touch. */
function makeRepoStub(basics: typeof GITLAB_BASICS | Record<string, unknown>, state: IndexState | null) {
  return {
    getRepoBasics: async () => basics,
    tryGetIndexState: async () => state,
    touchIndexState: async () => {},
    advanceSha: async () => {},
    deleteAllForRepo: async () => {},
    deleteForFiles: async () => {},
    insertSymbols: async () => {},
    insertReferences: async () => {},
    upsertIndexState: async () => {},
    replaceEdges: async () => {},
    replaceFileRank: async () => {},
    replaceFileFacts: async () => {},
    patchFileFacts: async () => {},
    resolveReferences: async () => {},
    getRepoMapCandidates: async () => [],
    deleteRepoMapCache: async () => {},
    putRepoMapCache: async () => {},
  } as unknown as RepoIntelRepository;
}

function makeContainer(git: unknown): Container {
  return {
    git,
    db: {},
    depgraph: { buildEdges: async () => [] },
    tokenizer: { count: (text: string) => Math.ceil(text.length / 4) },
  } as unknown as Container;
}

const GITLAB_REF: HostRepoRef = {
  owner: 'acme/platform',
  name: 'web',
  fullName: 'acme/platform/web',
  provider: 'gitlab',
  host: 'gitlab.com',
};

describe('HostRepoRef threading — repo-intel', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('resyncRepo on a GitLab row reaches the MockGitClient with provider gitlab', async () => {
    const git = new MockGitClient({ head: 'sha-1', syncedHead: 'sha-1' });
    const service = new RepoIntelService(makeContainer(git));
    (service as unknown as { repo: RepoIntelRepository }).repo = makeRepoStub(
      GITLAB_BASICS,
      stateAt('sha-1'),
    );

    const result = await service.resyncRepo(GITLAB_BASICS.id);

    expect(result.reason).toBe('sha_unchanged');
    expect(git.syncs).toHaveLength(1);
    expect(git.syncs[0]!.repo).toEqual(GITLAB_REF);
    expect(git.syncs[0]!.branch).toBe('main');
  });

  it('full + incremental index on a GitLab row pass the host-aware ref to the GitClient', async () => {
    dir = await mkdtemp(join(tmpdir(), 'devdigest-hostref-'));
    const seen: RepoRef[] = [];
    const git = {
      currentHead: async (ref: RepoRef) => {
        seen.push(ref);
        return 'sha-2';
      },
      diffNameOnly: async (ref: RepoRef) => {
        seen.push(ref);
        return [];
      },
    };
    const basics = { ...GITLAB_BASICS, clonePath: dir };

    await runFullIndex(makeContainer(git), makeRepoStub(basics, null), { repoId: basics.id });
    await runIncremental(makeContainer(git), makeRepoStub(basics, stateAt('sha-1')), {
      repoId: basics.id,
    });

    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const ref of seen) expect(ref).toEqual(GITLAB_REF);
  });

  it('a legacy row without provider/host resolves to github.com', async () => {
    const git = new MockGitClient({ head: 'sha-1', syncedHead: 'sha-1' });
    const service = new RepoIntelService(makeContainer(git));
    (service as unknown as { repo: RepoIntelRepository }).repo = makeRepoStub(
      { id: 'r1', owner: 'acme', name: 'app', fullName: 'acme/app', defaultBranch: 'main', clonePath: '/mock/clone' },
      stateAt('sha-1'),
    );

    await service.resyncRepo('r1');

    expect(git.syncs[0]!.repo).toEqual({
      owner: 'acme',
      name: 'app',
      fullName: 'acme/app',
      provider: 'github',
      host: 'github.com',
    });
  });
});
