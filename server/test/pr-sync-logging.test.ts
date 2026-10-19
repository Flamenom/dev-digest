import { describe, expect, it, vi } from 'vitest';
import { Container } from '../src/platform/container.js';
import { loadConfig } from '../src/platform/config.js';
import type { Db } from '../src/db/client.js';
import { MockAuthProvider, MockSecretsProvider } from '../src/adapters/mocks.js';
import type { SyncRepo } from '../src/modules/pulls/sync-service.js';

/**
 * Composition-root wiring: the container hands its process logger to the
 * detached PR-list sync coordinator, so a failed sync is LOGGED (warn, with the
 * repoId) and not only persisted. Hermetic — hosts are offline (the sync fails
 * before any client is built) and the status write fails on the stub db, which
 * the coordinator also reports through the same logger.
 */

const repo: SyncRepo = {
  id: 'repo-1',
  workspaceId: 'ws-1',
  owner: 'acme',
  name: 'api',
  fullName: 'acme/api',
  provider: 'github',
  host: 'github.com',
};

describe('Container → PR sync logger', () => {
  it('logs a failed sync at warn with the repoId', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DEVDIGEST_HOSTS_OFFLINE: 'true' } as NodeJS.ProcessEnv);
    const log = { warn: vi.fn() };
    const container = new Container(
      config,
      {} as Db,
      { secrets: new MockSecretsProvider({}), auth: new MockAuthProvider() },
      log,
    );

    container.prSync.manual(repo);
    const done = await container.prSync.awaitRunning(repo.id);

    expect(done?.state).toBe('failed');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: repo.id, err: expect.stringContaining('offline') }),
      'PR sync failed; serving persisted PRs',
    );
    // The stub db makes the status write throw: that error is logged as a
    // redacted string too, never as a raw error object.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: repo.id, err: expect.any(String) }),
      'PR sync status not persisted',
    );
  });

  it('logs through a module-tagged child logger when the logger supports it', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DEVDIGEST_HOSTS_OFFLINE: 'true' } as NodeJS.ProcessEnv);
    const childLog = { warn: vi.fn() };
    const log = { warn: vi.fn(), child: vi.fn(() => childLog) };
    const container = new Container(
      config,
      {} as Db,
      { secrets: new MockSecretsProvider({}), auth: new MockAuthProvider() },
      log,
    );

    container.prSync.manual(repo);
    await container.prSync.awaitRunning(repo.id);

    expect(log.child).toHaveBeenCalledWith({ module: 'pr-sync' });
    expect(log.warn).not.toHaveBeenCalled();
    expect(childLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: repo.id, err: expect.stringContaining('offline') }),
      'PR sync failed; serving persisted PRs',
    );
  });
});

describe('config.DEVDIGEST_HOSTS_OFFLINE', () => {
  it('accepts true/false/empty and rejects a typo at startup', () => {
    const load = (v: string) =>
      loadConfig({ NODE_ENV: 'test', DEVDIGEST_HOSTS_OFFLINE: v } as NodeJS.ProcessEnv);
    expect(load('true').hostsOffline).toBe(true);
    expect(load('false').hostsOffline).toBe(false);
    expect(load('').hostsOffline).toBe(false);
    expect(() => load('ture')).toThrow();
    expect(() => load('1')).toThrow();
  });
});
