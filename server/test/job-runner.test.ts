import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Db } from '../src/db/client.js';
import * as t from '../src/db/schema.js';
import { JobRunner } from '../src/platform/jobs.js';

/**
 * Hermetic JobRunner tests — a recording fake stands in for the Drizzle client
 * (only `insert().values().returning()` and `update().set().where()` are used),
 * so the job row's status transitions are observable without Postgres.
 */
function fakeDb() {
  const jobRow: Record<string, unknown> = {};
  const db = {
    insert(table: unknown) {
      expect(table).toBe(t.jobs);
      return {
        values(v: Record<string, unknown>) {
          Object.assign(jobRow, v, { id: 'job-1' });
          return { returning: async () => [{ id: 'job-1' }] };
        },
      };
    },
    update(table: unknown) {
      expect(table).toBe(t.jobs);
      return {
        set(v: Record<string, unknown>) {
          return {
            where: async () => {
              Object.assign(jobRow, v);
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as Db, jobRow };
}

/** Let any pending unhandled-rejection detection run (it fires after microtasks). */
async function flushRejectionDetection(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('JobRunner — failed background jobs', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    unhandled.length = 0;
  });

  it('records the failure and logs it without an unhandled rejection when nobody awaits `done`', async () => {
    process.on('unhandledRejection', onUnhandled);
    const { db, jobRow } = fakeDb();
    const log = { warn: vi.fn(), error: vi.fn() };
    const runner = new JobRunner(db, { retries: 0, log });
    runner.register('clone', async () => {
      throw new Error("fatal: unable to access 'https://oauth2:glpat-SECRET@gitlab.com/a/b.git/': 403");
    });

    // Fire-and-forget, exactly like RepoService.enqueueClone: `done` is dropped.
    await runner.enqueue('ws-1', 'clone', { repoId: 'r-1', token: 'payload-secret' });
    await runner.onIdle();
    await flushRejectionDetection();

    expect(unhandled).toEqual([]);
    expect(jobRow.status).toBe('failed');
    expect(String(jobRow.error)).toContain('403');

    expect(log.error).toHaveBeenCalledTimes(1);
    const [entry, msg] = log.error.mock.calls[0]!;
    expect(msg).toBe('background job failed');
    expect(entry).toEqual({ jobId: 'job-1', kind: 'clone', err: expect.stringContaining('403') });
    // No payload, no credentials in the log line.
    expect(JSON.stringify(entry)).not.toContain('payload-secret');
    expect(JSON.stringify(entry)).not.toContain('glpat-SECRET');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('still rejects `done` for a caller that awaits it (and works without a logger)', async () => {
    process.on('unhandledRejection', onUnhandled);
    const { db, jobRow } = fakeDb();
    const runner = new JobRunner(db, { retries: 0 });
    runner.register('index', async () => {
      throw new Error('boom');
    });

    const job = await runner.enqueue('ws-1', 'index', {});
    await expect(job.done).rejects.toThrow('boom');
    await flushRejectionDetection();

    expect(unhandled).toEqual([]);
    expect(jobRow.status).toBe('failed');
    expect(jobRow.error).toBe('boom');
  });

  it('falls back to `warn` when the logger has no `error`', async () => {
    const { db } = fakeDb();
    const log = { warn: vi.fn() };
    const runner = new JobRunner(db, { retries: 0, log });
    runner.register('resync', async () => {
      throw new Error('nope');
    });
    await runner.enqueue('ws-1', 'resync', {});
    await runner.onIdle();
    await flushRejectionDetection();
    expect(log.warn).toHaveBeenCalledWith(
      { jobId: 'job-1', kind: 'resync', err: 'nope' },
      'background job failed',
    );
  });
});
