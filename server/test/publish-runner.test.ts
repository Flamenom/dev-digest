/**
 * In-process publish tasks (plan "Background execution — decision"; spec AC-21, AC-34).
 */
import { describe, it, expect } from 'vitest';
import { PublishRunner } from '../src/modules/publish/runner.js';
import type { PublishRunInput } from '../src/modules/publish/executor.js';

const input = (id: string) => ({ publicationId: id }) as PublishRunInput;

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('PublishRunner', () => {
  it('start returns immediately; isActive until the task settles; whenIdle waits', async () => {
    const d = deferred();
    let runs = 0;
    const runner = new PublishRunner({
      executor: { run: () => ((runs += 1), d.promise) },
      log: { warn: () => {}, error: () => {} },
    });
    runner.start(input('p1'));
    expect(runner.isActive('p1')).toBe(true);
    expect(runner.isActive('p2')).toBe(false);

    runner.start(input('p1')); // a live publication is never started twice
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(1);

    let idle = false;
    const waiting = runner.whenIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    d.resolve();
    await waiting;
    expect(runner.isActive('p1')).toBe(false);
  });

  it('never throws to the caller; a failing task is logged by code only', async () => {
    const logs: unknown[] = [];
    const runner = new PublishRunner({
      executor: { run: async () => Promise.reject(new TypeError('body text must not leak')) },
      log: { warn: (o) => logs.push(o), error: (o) => logs.push(o) },
    });
    expect(() => runner.start(input('p1'))).not.toThrow();
    await runner.whenIdle();
    expect(runner.isActive('p1')).toBe(false);
    expect(logs).toEqual([{ publicationId: 'p1', code: 'TypeError' }]);
    expect(JSON.stringify(logs)).not.toContain('body text');
  });

  it('a synchronous throw from the executor is contained too', async () => {
    const runner = new PublishRunner({
      executor: {
        run: () => {
          throw new Error('sync');
        },
      },
      log: { warn: () => {}, error: () => {} },
    });
    expect(() => runner.start(input('p1'))).not.toThrow();
    await runner.whenIdle();
    expect(runner.isActive('p1')).toBe(false);
  });
});
