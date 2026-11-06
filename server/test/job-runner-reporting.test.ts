/**
 * AC-34 / AC-42 — JobRunner reports an internal background-job failure once,
 * after the final attempt; expected failures are not reported; a throwing
 * reporter never becomes an unhandled rejection. Hermetic (fake Drizzle client).
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Db } from '../src/db/client.js';
import { JobRunner } from '../src/platform/jobs.js';
import { AppError } from '../src/platform/errors.js';
import type { ErrorReporter, ReportContext } from '../src/platform/error-reporting.js';

function fakeDb(): Db {
  const db = {
    insert: () => ({ values: () => ({ returning: async () => [{ id: 'job-1' }] }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  };
  return db as unknown as Db;
}

function recordingReporter() {
  const captures: Array<{ err: unknown; ctx?: ReportContext }> = [];
  const reporter: ErrorReporter = {
    capture: (err, ctx) => void captures.push({ err, ctx }),
    flush: async () => true,
  };
  return { reporter, captures };
}

async function flushRejectionDetection(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('JobRunner — error reporting', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    unhandled.length = 0;
  });

  it('captures exactly once after the final retry, with the job kind', async () => {
    const { reporter, captures } = recordingReporter();
    const runner = new JobRunner(fakeDb(), { retries: 2, reporter });
    let attempts = 0;
    runner.register('index', async () => {
      attempts += 1;
      // A retryable (network-ish) internal error, so every attempt runs.
      throw Object.assign(new Error('index exploded'), { code: 'ECONNRESET' });
    });
    await runner.enqueue('ws-1', 'index', {});
    await runner.onIdle();
    await flushRejectionDetection();

    expect(attempts).toBe(3);
    expect(captures).toHaveLength(1);
    expect((captures[0]!.err as Error).message).toBe('index exploded');
    expect(captures[0]!.ctx).toEqual({ jobKind: 'index' });
  }, 20_000);

  it('does not capture an expected failure (AppError < 500)', async () => {
    const { reporter, captures } = recordingReporter();
    const runner = new JobRunner(fakeDb(), { retries: 0, reporter });
    runner.register('clone', async () => {
      throw new AppError('not_found', 'repo gone', 404);
    });
    await runner.enqueue('ws-1', 'clone', {});
    await runner.onIdle();
    await flushRejectionDetection();
    expect(captures).toEqual([]);
  });

  it('a throwing reporter does not cause an unhandled rejection (and logging still happens)', async () => {
    process.on('unhandledRejection', onUnhandled);
    const reporter: ErrorReporter = {
      capture: () => {
        throw new Error('sentry exploded');
      },
      flush: async () => true,
    };
    const logged: unknown[] = [];
    const runner = new JobRunner(fakeDb(), {
      retries: 0,
      reporter,
      log: { warn: (o) => logged.push(o) },
    });
    runner.register('clone', async () => {
      throw new Error('boom');
    });
    await runner.enqueue('ws-1', 'clone', {});
    await runner.onIdle();
    await flushRejectionDetection();
    expect(unhandled).toEqual([]);
    expect(logged).toHaveLength(1);
  });
});
