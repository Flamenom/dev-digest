import { describe, it, expect, vi } from 'vitest';
import type {
  HostRepoRef,
  PrMetaHost,
  PullDetailResult,
  PullRequestHost,
  PullStateInfo,
  RepoProvider,
} from '@devdigest/shared';
import { PrListSyncService, type SyncRepo } from '../src/modules/pulls/sync-service.js';
import type { PullRequestStore } from '../src/modules/pulls/repository.js';
import { PrSyncCoordinator } from '../src/modules/pulls/sync-coordinator.js';
import type { RepoSyncStatus, SyncStatusStore } from '../src/modules/pulls/repository.js';

function mr(number: number, over: Partial<PrMetaHost> = {}): PrMetaHost {
  return {
    number,
    title: `MR ${number}`,
    author: 'dev',
    branch: `feat/${number}`,
    base: 'main',
    head_sha: `sha-${number}`,
    additions: 3,
    deletions: 1,
    files_count: 2,
    status: 'open',
    opened_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-02T00:00:00.000Z',
    ...over,
  };
}

/** Records every call and how many host requests are in flight at once. */
class FakeHost implements PullRequestHost {
  readonly readOnly: boolean;
  calls: string[] = [];
  inFlight = 0;
  maxInFlight = 0;
  constructor(
    readonly provider: RepoProvider,
    private list: PrMetaHost[],
    private states: PullStateInfo[] = [],
    private opts: { detailThrows?: boolean; listError?: Error } = {},
  ) {
    this.readOnly = provider === 'gitlab';
  }
  private async track<T>(name: string, fn: () => T): Promise<T> {
    this.calls.push(name);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await Promise.resolve();
    try {
      return fn();
    } finally {
      this.inFlight -= 1;
    }
  }
  listPullRequests(_ref: HostRepoRef) {
    return this.track('list', () => {
      if (this.opts.listError) throw this.opts.listError;
      return this.list;
    });
  }
  getPullStates(_ref: HostRepoRef, numbers: number[]) {
    return this.track(`states:${numbers.join(',')}`, () =>
      this.states.filter((s) => numbers.includes(s.number)),
    );
  }
  getPullRequestDetail(_ref: HostRepoRef, n: number): Promise<PullDetailResult> {
    return this.track(`detail:${n}`, () => {
      if (this.opts.detailThrows) throw new Error('detail/diff must not be called');
      const meta = mr(n, { additions: 10 * n, deletions: n, files_count: n });
      return { kind: 'full' as const, detail: { ...meta, body: null, files: [], commits: [] } };
    });
  }
  getIssue() {
    return this.track('issue', () => {
      throw new Error('issue must not be called');
    });
  }
  getLinkedIssueNumber() {
    return this.track('linked', () => {
      throw new Error('linked issue must not be called');
    });
  }
}

/** In-memory PullRequestStore — tracks rows by number for one repo. */
function fakeStore(open: number[] = [], missing: { id: string; number: number }[] = []) {
  const calls = {
    upsertList: vi.fn<PullRequestStore['upsertList']>(async (_s, p) => p.length),
    upsertListWithStats: vi.fn<PullRequestStore['upsertListWithStats']>(async (_s, p) => p.length),
    updateDiffStats: vi.fn<PullRequestStore['updateDiffStats']>(async () => {}),
    listOpenNumbers: vi.fn<PullRequestStore['listOpenNumbers']>(async () => open),
    updateStatuses: vi.fn<PullRequestStore['updateStatuses']>(async (_s, st) => st.length),
    listMissingStats: vi.fn<PullRequestStore['listMissingStats']>(async (_s, limit) => missing.slice(0, limit)),
    replaceDetail: vi.fn<PullRequestStore['replaceDetail']>(async () => true),
    getPersistedDetail: vi.fn<PullRequestStore['getPersistedDetail']>(async () => ({
      files: [],
      commits: [],
    })),
  };
  return calls satisfies PullRequestStore;
}

const gitlabRepo: SyncRepo = {
  id: 'gl-1',
  workspaceId: 'ws',
  owner: 'space-profit/platform',
  name: 'crm-frontend',
  fullName: 'space-profit/platform/crm-frontend',
  provider: 'gitlab',
  host: 'gitlab.com',
};
const githubRepo: SyncRepo = {
  id: 'gh-1',
  workspaceId: 'ws',
  owner: 'acme',
  name: 'api',
  fullName: 'acme/api',
  provider: 'github',
  host: 'github.com',
};

describe('PrListSyncService', () => {
  it('GitLab: stores list metadata + stats only, never fetching detail/diffs (AC-18)', async () => {
    const host = new FakeHost('gitlab', [mr(5, { is_draft: true }), mr(6, { stats_known: false })], [], {
      detailThrows: true,
    });
    const store = fakeStore([5, 6]);
    const svc = new PrListSyncService({ hosts: async () => host, store });

    await svc.syncRepo(gitlabRepo);

    expect(host.calls).toEqual(['list']);
    expect(store.upsertListWithStats).toHaveBeenCalledTimes(1);
    expect(store.upsertListWithStats.mock.calls[0]![0]).toEqual({ workspaceId: 'ws', repoId: 'gl-1' });
    expect(store.upsertListWithStats.mock.calls[0]![1].map((p) => p.number)).toEqual([5, 6]);
    expect(store.upsertList).not.toHaveBeenCalled();
    expect(store.updateDiffStats).not.toHaveBeenCalled();
    expect(store.updateStatuses).not.toHaveBeenCalled();
  });

  it('GitLab: a persisted open MR missing from the list is reconciled to merged (AC-28)', async () => {
    const host = new FakeHost('gitlab', [mr(5)], [{ number: 7, status: 'merged' }]);
    const store = fakeStore([5, 7]);
    const svc = new PrListSyncService({ hosts: async () => host, store });

    await svc.syncRepo(gitlabRepo);

    expect(host.calls).toEqual(['list', 'states:7']);
    expect(store.updateStatuses).toHaveBeenCalledWith({ workspaceId: 'ws', repoId: 'gl-1' }, [
      { number: 7, status: 'merged' },
    ]);
    expect(host.maxInFlight).toBe(1);
  });

  it('GitHub: unchanged upsert rule, then sequential backfill of ≤ 10 zero-stat PRs', async () => {
    const host = new FakeHost('github', [mr(1), mr(2)]);
    const missing = Array.from({ length: 12 }, (_, i) => ({ id: `pr-${i + 1}`, number: i + 1 }));
    const store = fakeStore([], missing);
    const svc = new PrListSyncService({ hosts: async () => host, store });

    await svc.syncRepo(githubRepo);

    expect(store.upsertList).toHaveBeenCalledTimes(1);
    expect(store.upsertListWithStats).not.toHaveBeenCalled();
    expect(store.listMissingStats.mock.calls[0]![1]).toBe(10);
    expect(host.calls.filter((c) => c.startsWith('detail:'))).toHaveLength(10);
    expect(host.maxInFlight).toBe(1);
    expect(store.updateDiffStats).toHaveBeenCalledTimes(10);
    expect(store.updateDiffStats.mock.calls[2]).toEqual([
      'ws',
      'pr-3',
      { additions: 30, deletions: 3, filesCount: 3 },
    ]);
  });

  it('GitHub: one failing backfill skips only that PR', async () => {
    const host = new FakeHost('github', [], [], { detailThrows: true });
    const store = fakeStore([], [{ id: 'a', number: 1 }]);
    const log = { warn: vi.fn() };
    const svc = new PrListSyncService({ hosts: async () => host, store, log });

    await expect(svc.syncRepo(githubRepo)).resolves.toBeUndefined();
    expect(store.updateDiffStats).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    // The host error reaches the logger as a redacted string, never the raw object.
    expect(log.warn).toHaveBeenCalledWith(
      { err: 'detail/diff must not be called', number: 1 },
      'PR diff-stat backfill skipped',
    );
  });

  it('a failing GitHub host does not affect a parallel GitLab repo sync (AC-27)', async () => {
    const gitlab = new FakeHost('gitlab', [mr(5)]);
    const store = fakeStore([5]);
    const svc = new PrListSyncService({
      hosts: async (p) => {
        if (p === 'github') throw new Error('GITHUB_TOKEN missing');
        return gitlab;
      },
      store,
    });
    const rows = new Map<string, RepoSyncStatus>();
    const status: SyncStatusStore = {
      get: async (_w, id) => rows.get(id) ?? null,
      recordSuccess: async (_w, id, at) => {
        rows.set(id, { lastSyncedAt: at, lastAttemptAt: at, lastSyncError: null });
      },
      recordFailure: async (_w, id, at, error) => {
        rows.set(id, { lastSyncedAt: null, lastAttemptAt: at, lastSyncError: error });
      },
    };
    const coord = new PrSyncCoordinator<SyncRepo>({
      ttlMs: 60_000,
      backoffMs: 60_000,
      now: () => Date.parse('2026-10-16T10:00:00.000Z'),
      status,
      run: (r) => svc.syncRepo(r),
    });

    expect(coord.manual(githubRepo)).toBe('started');
    expect(coord.manual(gitlabRepo)).toBe('started');
    const [gh, gl] = await Promise.all([coord.awaitRunning('gh-1'), coord.awaitRunning('gl-1')]);

    expect(gh).toMatchObject({ state: 'failed', last_sync_error: 'GITHUB_TOKEN missing' });
    expect(gl).toMatchObject({ state: 'idle', last_synced_at: '2026-10-16T10:00:00.000Z' });
    expect(store.upsertListWithStats).toHaveBeenCalledTimes(1);
  });

  it('a list failure rejects (the coordinator records it) and writes nothing', async () => {
    const host = new FakeHost('gitlab', [], [], { listError: new Error('GitLab 503') });
    const store = fakeStore();
    const svc = new PrListSyncService({ hosts: async () => host, store });
    await expect(svc.syncRepo(gitlabRepo)).rejects.toThrow('GitLab 503');
    expect(store.upsertListWithStats).not.toHaveBeenCalled();
  });
});
