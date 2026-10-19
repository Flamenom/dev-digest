import type { PrListSync, PrSyncDoneEvent, PrSyncStartResult, PrSyncTrigger } from '@devdigest/shared';
import type { RepoSyncStatus, SyncStatusStore } from './repository.js';
import { describeSyncError, type SyncLogger } from './sync-service.js';

/** The repo fields the coordinator keys on; `run` receives the full value back. */
export interface CoordinatedRepo {
  id: string;
  workspaceId: string;
}

/** `PrListSync` without the per-request `trigger`. */
export type PrSyncSnapshot = Omit<PrListSync, 'trigger'>;

export type SyncDoneListener = (event: PrSyncDoneEvent) => void;

export interface PrSyncCoordinatorDeps<R extends CoordinatedRepo> {
  /** No open-triggered sync while the last SUCCESS is younger than this (AC-56/61). */
  ttlMs: number;
  /** No open-triggered sync while the last FAILED attempt is younger than this (AC-62). */
  backoffMs: number;
  /** Injected clock (epoch ms) — never `Date.now()` directly, so tests drive time. */
  now: () => number;
  status: SyncStatusStore;
  /** One PR-list sync; rejects on failure. */
  run: (repo: R) => Promise<void>;
  /** Failure → persisted human-readable message. Default: redacted, single-line, ≤ 500 chars. */
  describeError?: (err: unknown) => string;
  /** Every error this logs goes through `describeError` first — never a raw error object. */
  log?: SyncLogger;
}

interface Inflight {
  promise: Promise<PrSyncDoneEvent>;
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function later(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * Sync-on-open single-flight coordinator — ONE per process (container singleton).
 *
 * - `onOpen`: running → `joined`; last success within TTL → `fresh`; last
 *   attempt failed within back-off → `fresh`; otherwise start → `started`.
 * - `manual`: bypasses TTL/back-off; joins a running sync or starts one.
 *
 * A started sync is a DETACHED promise: it is never tied to the HTTP request
 * that triggered it, so a closed tab / aborted request cannot cancel it (AC-64).
 * On completion it persists `last_attempt_at` (+ `last_synced_at`, error=null on
 * success; a redacted `last_sync_error` on failure), drops the in-flight entry
 * and THEN notifies `onDone` listeners — so a listener reading `isRunning` /
 * `snapshot` already sees the finished state. `running` is never persisted.
 */
export class PrSyncCoordinator<R extends CoordinatedRepo = CoordinatedRepo> {
  private inflight = new Map<string, Inflight>();
  private listeners = new Map<string, Set<SyncDoneListener>>();
  /**
   * Outcome of the last sync THIS process finished, per repo. Covers the window
   * where a status read raced the completion write (the read may return the
   * pre-sync row), so a just-finished sync is never immediately re-run.
   */
  private recent = new Map<string, RepoSyncStatus>();
  private readonly describeError: (err: unknown) => string;

  constructor(private deps: PrSyncCoordinatorDeps<R>) {
    this.describeError = deps.describeError ?? describeSyncError;
  }

  isRunning(repoId: string): boolean {
    return this.inflight.has(repoId);
  }

  /** Page open: never awaits the sync itself, only the (cheap) status read. */
  async onOpen(repo: R): Promise<PrSyncTrigger> {
    if (this.inflight.has(repo.id)) return 'joined';
    const status = await this.readStatus(repo);
    // Re-check after the await: a concurrent open may have started one meanwhile.
    if (this.inflight.has(repo.id)) return 'joined';
    if (this.isFresh(status)) return 'fresh';
    this.start(repo);
    return 'started';
  }

  /** Manual refresh: ignores TTL and back-off, but still single-flight (AC-58). */
  manual(repo: R): PrSyncStartResult['trigger'] {
    if (this.inflight.has(repo.id)) return 'joined';
    this.start(repo);
    return 'started';
  }

  /** Resolves with the running sync's outcome; `null` when none is running. Never rejects. */
  awaitRunning(repoId: string): Promise<PrSyncDoneEvent | null> {
    return this.inflight.get(repoId)?.promise ?? Promise.resolve(null);
  }

  /**
   * One-shot listener for the NEXT completion of `repoId`'s sync. Returns an
   * unsubscribe function (call it when the SSE connection closes). Registering
   * while nothing runs is allowed; the caller decides whether to wait.
   */
  onDone(repoId: string, cb: SyncDoneListener): () => void {
    let set = this.listeners.get(repoId);
    if (!set) {
      set = new Set();
      this.listeners.set(repoId, set);
    }
    set.add(cb);
    return () => {
      const current = this.listeners.get(repoId);
      current?.delete(cb);
      if (current && current.size === 0) this.listeners.delete(repoId);
    };
  }

  /** Current persisted sync status + the in-memory `running` flag. */
  async snapshot(repo: R): Promise<PrSyncSnapshot> {
    const status = await this.readStatus(repo);
    return this.toSnapshot(status, this.inflight.has(repo.id));
  }

  // ---- internals ----------------------------------------------------------

  private isFresh(status: RepoSyncStatus): boolean {
    const now = this.deps.now();
    if (status.lastSyncedAt && now - status.lastSyncedAt.getTime() < this.deps.ttlMs) return true;
    if (
      status.lastSyncError != null &&
      status.lastAttemptAt &&
      now - status.lastAttemptAt.getTime() < this.deps.backoffMs
    ) {
      return true;
    }
    return false;
  }

  /** Persisted status merged with this process's newer completion (if any). */
  private async readStatus(repo: R): Promise<RepoSyncStatus> {
    const stored = (await this.deps.status.get(repo.workspaceId, repo.id)) ?? {
      lastSyncedAt: null,
      lastAttemptAt: null,
      lastSyncError: null,
    };
    const mem = this.recent.get(repo.id);
    if (!mem?.lastAttemptAt) return stored;
    if (stored.lastAttemptAt && stored.lastAttemptAt.getTime() > mem.lastAttemptAt.getTime()) {
      return stored;
    }
    return {
      lastSyncedAt: later(stored.lastSyncedAt, mem.lastSyncedAt),
      lastAttemptAt: mem.lastAttemptAt,
      lastSyncError: mem.lastSyncError,
    };
  }

  private toSnapshot(status: RepoSyncStatus, running: boolean): PrSyncSnapshot {
    return {
      state: running ? 'running' : status.lastSyncError != null ? 'failed' : 'idle',
      last_synced_at: iso(status.lastSyncedAt),
      last_attempt_at: iso(status.lastAttemptAt),
      last_sync_error: status.lastSyncError,
    };
  }

  private start(repo: R): void {
    // `run` is deferred to a microtask and the in-flight entry is set
    // synchronously, so every later caller in this tick already sees it
    // (single-flight), even if `run` itself is synchronous.
    const promise = Promise.resolve()
      .then(() => this.execute(repo))
      .catch((err: unknown) => {
      // execute() handles its own errors; this is a last-resort guard so a
      // detached promise can never become an unhandled rejection.
      this.deps.log?.warn(
        { err: this.describeError(err), repoId: repo.id },
        'PR sync bookkeeping failed',
      );
      this.inflight.delete(repo.id);
      const event: PrSyncDoneEvent = { state: 'failed', last_synced_at: null, last_sync_error: 'PR sync failed' };
      this.notify(repo.id, event);
      return event;
    });
    this.inflight.set(repo.id, { promise });
  }

  private async execute(repo: R): Promise<PrSyncDoneEvent> {
    let error: string | null = null;
    try {
      await this.deps.run(repo);
    } catch (err) {
      error = this.describeError(err);
      this.deps.log?.warn({ err: error, repoId: repo.id }, 'PR sync failed; serving persisted PRs');
    }

    const at = new Date(this.deps.now());
    const prev = this.recent.get(repo.id);
    try {
      if (error == null) await this.deps.status.recordSuccess(repo.workspaceId, repo.id, at);
      else await this.deps.status.recordFailure(repo.workspaceId, repo.id, at, error);
    } catch (err) {
      this.deps.log?.warn(
        { err: this.describeError(err), repoId: repo.id },
        'PR sync status not persisted',
      );
    }

    let lastSyncedAt: Date | null;
    if (error == null) lastSyncedAt = at;
    else {
      const stored = await this.deps.status.get(repo.workspaceId, repo.id).catch(() => null);
      lastSyncedAt = later(stored?.lastSyncedAt ?? null, prev?.lastSyncedAt ?? null);
    }
    this.recent.set(repo.id, { lastSyncedAt, lastAttemptAt: at, lastSyncError: error });

    const event: PrSyncDoneEvent = {
      state: error == null ? 'idle' : 'failed',
      last_synced_at: iso(lastSyncedAt),
      last_sync_error: error,
    };
    this.inflight.delete(repo.id);
    this.notify(repo.id, event);
    return event;
  }

  private notify(repoId: string, event: PrSyncDoneEvent): void {
    const set = this.listeners.get(repoId);
    if (!set) return;
    this.listeners.delete(repoId);
    for (const cb of set) {
      try {
        cb(event);
      } catch (err) {
        this.deps.log?.warn({ err: this.describeError(err), repoId }, 'PR sync onDone listener threw');
      }
    }
  }
}
