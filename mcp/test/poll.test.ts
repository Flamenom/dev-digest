import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@devdigest/shared';
import type { DevDigestApi } from '../src/api.js';
import { waitForRun } from '../src/poll.js';
import { makeRun } from './fixtures.js';

/** Fake api serving a scripted sequence of /runs responses + a fake clock that
    advances only when sleep() is awaited — no real timers anywhere. */
function scriptedApi(sequence: RunSummary[][]) {
  let clock = 0;
  let polls = 0;
  const sleeps: number[] = [];
  const api: DevDigestApi = {
    async get<T>(path: string): Promise<T> {
      expect(path).toBe('/pulls/pr-uuid-482/runs');
      const step = sequence[Math.min(polls, sequence.length - 1)];
      polls += 1;
      return step as T;
    },
    async post<T>(): Promise<T> {
      throw new Error('unexpected post');
    },
  };
  return {
    api,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    getPolls: () => polls,
    sleeps,
  };
}

const OPTS = { intervalMs: 4000, timeoutMs: 120_000 };

describe('waitForRun', () => {
  it('returns the run once it leaves "running" (done on the 3rd poll)', async () => {
    const done = makeRun({ status: 'done', score: 61 });
    const s = scriptedApi([[makeRun()], [makeRun()], [done]]);
    const res = await waitForRun(s.api, 'pr-uuid-482', 'run-uuid-1', {
      ...OPTS,
      now: s.now,
      sleep: s.sleep,
    });
    expect(res).toEqual({ timedOut: false, run: done });
    expect(s.getPolls()).toBe(3);
    expect(s.sleeps).toEqual([4000, 4000]);
  });

  it('returns a failed run immediately without treating it as timeout', async () => {
    const failed = makeRun({ status: 'failed', error: 'OPENROUTER key missing' });
    const s = scriptedApi([[failed]]);
    const res = await waitForRun(s.api, 'pr-uuid-482', 'run-uuid-1', {
      ...OPTS,
      now: s.now,
      sleep: s.sleep,
    });
    expect(res.timedOut).toBe(false);
    if (!res.timedOut) expect(res.run.error).toBe('OPENROUTER key missing');
    expect(s.sleeps).toEqual([]);
  });

  it('keeps polling while the run is not yet visible in the list', async () => {
    const done = makeRun({ status: 'done' });
    const s = scriptedApi([[], [], [done]]);
    const res = await waitForRun(s.api, 'pr-uuid-482', 'run-uuid-1', {
      ...OPTS,
      now: s.now,
      sleep: s.sleep,
    });
    expect(res).toEqual({ timedOut: false, run: done });
  });

  it('times out after the 120 s budget while the run keeps running', async () => {
    const s = scriptedApi([[makeRun()]]); // forever running
    const res = await waitForRun(s.api, 'pr-uuid-482', 'run-uuid-1', {
      ...OPTS,
      now: s.now,
      sleep: s.sleep,
    });
    expect(res).toEqual({ timedOut: true });
    // 4 s cadence over a 120 s budget → 30 sleeps, 31 polls, no more.
    expect(s.sleeps).toHaveLength(30);
    expect(s.getPolls()).toBe(31);
  });
});
