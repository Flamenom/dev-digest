/* poll.ts — pure waiting logic over the injected DevDigestApi. Mirrors the web
   client's 4 s run-status polling (client/src/lib/hooks/reviews.ts); clock and
   sleep are injectable so tests run hermetically with fake timers. */

import type { RunSummary } from '@devdigest/shared';
import type { DevDigestApi } from './api.js';

export interface WaitForRunOptions {
  intervalMs: number;
  timeoutMs: number;
  /** Injectable clock (default Date.now). */
  now?: () => number;
  /** Injectable sleep (default setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

export type WaitForRunResult = { timedOut: false; run: RunSummary } | { timedOut: true };

/**
 * Poll `GET /pulls/:prId/runs` until the run leaves 'running' (→ done | failed
 * | cancelled), or the budget elapses (→ { timedOut: true }). A run not yet
 * visible in the list counts as still running.
 */
export async function waitForRun(
  api: DevDigestApi,
  prId: string,
  runId: string,
  opts: WaitForRunOptions,
): Promise<WaitForRunResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + opts.timeoutMs;

  for (;;) {
    const runs = await api.get<RunSummary[]>(`/pulls/${encodeURIComponent(prId)}/runs`);
    const run = runs.find((r) => r.run_id === runId);
    if (run && run.status !== 'running') return { timedOut: false, run };
    if (now() >= deadline) return { timedOut: true };
    await sleep(opts.intervalMs);
  }
}
