import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PrSyncDoneEvent } from '@devdigest/shared';
import { PrSyncCoordinator, type CoordinatedRepo } from '../src/modules/pulls/sync-coordinator.js';
import type { RepoSyncStatus, SyncStatusStore } from '../src/modules/pulls/repository.js';

/** In-memory SyncStatusStore — the coordinator's only persistence dependency. */
class FakeStatusStore implements SyncStatusStore {
  rows = new Map<string, RepoSyncStatus>();
  async get(_ws: string, repoId: string) {
    const r = this.rows.get(repoId);
    return r ? { ...r } : { lastSyncedAt: null, lastAttemptAt: null, lastSyncError: null };
  }
  async recordSuccess(_ws: string, repoId: string, at: Date) {
    this.rows.set(repoId, { lastSyncedAt: at, lastAttemptAt: at, lastSyncError: null });
  }
  async recordFailure(_ws: string, repoId: string, at: Date, error: string) {
    const prev = this.rows.get(repoId);
    this.rows.set(repoId, { lastSyncedAt: prev?.lastSyncedAt ?? null, lastAttemptAt: at, lastSyncError: error });
  }
}

const TTL = 60_000;
const repo: CoordinatedRepo = { id: 'repo-1', workspaceId: 'ws-1' };

/** Flush pending microtasks (promise chains) without advancing fake time. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('PrSyncCoordinator', () => {
  let status: FakeStatusStore;
  let runs: number;
  let runImpl: () => Promise<void>;
  let coord: PrSyncCoordinator;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-16T10:00:00.000Z') });
    status = new FakeStatusStore();
    runs = 0;
    runImpl = async () => {};
    coord = new PrSyncCoordinator({
      ttlMs: TTL,
      backoffMs: TTL,
      now: () => Date.now(),
      status,
      run: () => {
        runs += 1;
        return runImpl();
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function succeedOnce(): Promise<void> {
    expect(coord.manual(repo)).toBe('started');
    await coord.awaitRunning(repo.id);
  }

  it('starts exactly one sync on open 61 s after the last success (AC-56)', async () => {
    await succeedOnce();
    runs = 0;
    await vi.advanceTimersByTimeAsync(61_000);

    expect(await coord.onOpen(repo)).toBe('started');
    expect(coord.isRunning(repo.id)).toBe(true);
    await coord.awaitRunning(repo.id);
    expect(runs).toBe(1);
  });

  it('makes no provider call for opens within the TTL (AC-61)', async () => {
    await succeedOnce();
    runs = 0;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(await coord.onOpen(repo)).toBe('fresh');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await coord.onOpen(repo)).toBe('fresh');
    await flush();
    expect(runs).toBe(0);

    const snap = await coord.snapshot(repo);
    expect(snap.state).toBe('idle');
    expect(snap.last_synced_at).toBe('2026-10-16T10:00:00.000Z');
  });

  it('a failing host is tried once per back-off window, however many opens (AC-62)', async () => {
    runImpl = async () => {
      throw new Error('GitLab 500 Authorization: Bearer glpat-secret123 at https://u:pw@gitlab.com/x');
    };
    const triggers: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      triggers.push(await coord.onOpen(repo));
      await coord.awaitRunning(repo.id);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(runs).toBe(1);
    expect(triggers[0]).toBe('started');
    expect(triggers.slice(1).every((t) => t === 'fresh')).toBe(true);

    const snap = await coord.snapshot(repo);
    expect(snap.state).toBe('failed');
    expect(snap.last_synced_at).toBeNull();
    // Persisted error is human-readable and redacted.
    expect(snap.last_sync_error).toContain('GitLab 500');
    expect(snap.last_sync_error).not.toContain('glpat-secret123');
    expect(snap.last_sync_error).not.toContain('u:pw@');

    // Back-off over → the next open retries; manual can always retry.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await coord.onOpen(repo)).toBe('started');
    await coord.awaitRunning(repo.id);
    expect(coord.manual(repo)).toBe('started');
    await coord.awaitRunning(repo.id);
    expect(runs).toBe(3);
  });

  it('10 concurrent opens during a 20 s sync → 1 run, 9 joined, all 10 listeners fire (AC-57)', async () => {
    runImpl = () => new Promise<void>((resolve) => setTimeout(resolve, 20_000));
    const events: PrSyncDoneEvent[] = [];

    const triggers = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const t = await coord.onOpen(repo);
        coord.onDone(repo.id, (e) => events.push(e));
        return t;
      }),
    );
    expect(triggers.filter((t) => t === 'started')).toHaveLength(1);
    expect(triggers.filter((t) => t === 'joined')).toHaveLength(9);
    expect((await coord.snapshot(repo)).state).toBe('running');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();

    expect(runs).toBe(1);
    expect(events).toHaveLength(10);
    expect(events.every((e) => e.state === 'idle' && e.last_synced_at === '2026-10-16T10:00:20.000Z')).toBe(true);
    expect(coord.isRunning(repo.id)).toBe(false);
  });

  it('manual refresh bypasses the TTL but joins a running sync (AC-58)', async () => {
    await succeedOnce();
    runs = 0;
    await vi.advanceTimersByTimeAsync(5_000);

    runImpl = () => new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    const results = Array.from({ length: 5 }, () => coord.manual(repo));
    expect(results).toEqual(['started', 'joined', 'joined', 'joined', 'joined']);
    expect(await coord.onOpen(repo)).toBe('joined');

    await vi.advanceTimersByTimeAsync(3_000);
    expect(await coord.awaitRunning(repo.id)).toBeNull();
    expect(runs).toBe(1);
  });

  it('a sync whose caller discarded the promise still persists; re-open within TTL is fresh (AC-64)', async () => {
    runImpl = () => new Promise<void>((resolve) => setTimeout(resolve, 15_000));
    // Fire-and-forget, exactly like a request that is closed mid-sync.
    void coord.onOpen(repo);
    await flush();
    expect(coord.isRunning(repo.id)).toBe(true);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(coord.isRunning(repo.id)).toBe(false);
    const row = status.rows.get(repo.id)!;
    expect(row.lastSyncedAt?.toISOString()).toBe('2026-10-16T10:00:15.000Z');
    expect(row.lastSyncError).toBeNull();

    // TTL counts from completion, not from start.
    await vi.advanceTimersByTimeAsync(50_000);
    expect(await coord.onOpen(repo)).toBe('fresh');
    expect(runs).toBe(1);
  });

  it('awaitRunning resolves null when idle and the outcome when running; listener unsubscribe works', async () => {
    expect(await coord.awaitRunning(repo.id)).toBeNull();
    runImpl = () => new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    const fired = vi.fn();
    const off = coord.onDone(repo.id, fired);
    coord.manual(repo);
    off();
    const done = coord.awaitRunning(repo.id);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await done)?.state).toBe('idle');
    expect(fired).not.toHaveBeenCalled();
  });

  it('keeps repos independent: one repo failing does not block another (AC-27)', async () => {
    const other: CoordinatedRepo = { id: 'repo-2', workspaceId: 'ws-1' };
    const c = new PrSyncCoordinator({
      ttlMs: TTL,
      backoffMs: TTL,
      now: () => Date.now(),
      status,
      run: async (r) => {
        if (r.id === repo.id) throw new Error('GitHub token revoked');
      },
    });
    expect(await c.onOpen(repo)).toBe('started');
    expect(await c.onOpen(other)).toBe('started');
    const [a, b] = await Promise.all([c.awaitRunning(repo.id), c.awaitRunning(other.id)]);
    expect(a?.state).toBe('failed');
    expect(b?.state).toBe('idle');
  });

  it('a throwing describeError never leaves the repo stuck in flight', async () => {
    const warns: unknown[] = [];
    const c = new PrSyncCoordinator({
      ttlMs: TTL,
      backoffMs: TTL,
      now: () => Date.now(),
      status,
      run: async () => {
        throw new Error('host down');
      },
      describeError: () => {
        throw new Error('describe exploded');
      },
      log: { warn: (obj: unknown) => void warns.push(obj) },
    });
    expect(c.manual(repo)).toBe('started');
    const done = await c.awaitRunning(repo.id);
    expect(done?.state).toBe('failed');
    expect(done?.last_sync_error).toBe('PR sync failed');
    expect(c.isRunning(repo.id)).toBe(false);
    // The slot is free: the next manual refresh starts a new sync, not "joined".
    expect(c.manual(repo)).toBe('started');
    await c.awaitRunning(repo.id);
    expect(c.isRunning(repo.id)).toBe(false);
    expect(warns.length).toBeGreaterThan(0);
  });
});
