import PQueue from 'p-queue';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import * as t from '../db/schema.js';
import { withTimeout, withRetry } from './resilience.js';
import { redactSecret } from './redact.js';

/**
 * JobRunner — async work (clone, PR import, indexing, polling) on a
 * concurrency-limited p-queue, mirrored into the `jobs` table with
 * timeouts + retry/backoff.
 *
 * Handlers are registered by kind. enqueue() inserts a `jobs` row, schedules
 * the handler on the queue, and updates status/attempts/error as it runs.
 */

export type JobHandler = (payload: unknown, ctx: { jobId: string }) => Promise<void>;

/**
 * Structural logger for failed background jobs — pino satisfies it, so the
 * platform does not import a framework logger type. `error` is preferred when
 * present; `warn` is the minimum (the container's process logger shape).
 */
export interface JobLogger {
  warn: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
  child?: (bindings: Record<string, unknown>) => JobLogger;
}

export interface JobRunnerOptions {
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
  /** Where a failed job is reported (jobId, kind, redacted message only). */
  log?: JobLogger;
}

export interface EnqueuedJob {
  id: string;
  /**
   * Resolves when the job finishes (or rejects if it ultimately fails). Awaiting
   * it is optional: the runner already observes a failure (logs it), so an
   * un-awaited failed job never becomes an unhandled rejection.
   */
  done: Promise<void>;
}

export class JobRunner {
  private queue: PQueue;
  private handlers = new Map<string, JobHandler>();
  private timeoutMs: number;
  private retries: number;
  private log?: JobLogger;

  constructor(
    private db: Db,
    opts: JobRunnerOptions = {},
  ) {
    this.queue = new PQueue({ concurrency: opts.concurrency ?? 3 });
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.retries = opts.retries ?? 2;
    this.log = opts.log;
  }

  register(kind: string, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  async enqueue(workspaceId: string, kind: string, payload: unknown): Promise<EnqueuedJob> {
    const handler = this.handlers.get(kind);
    if (!handler) throw new Error(`No job handler registered for kind '${kind}'`);

    const [row] = await this.db
      .insert(t.jobs)
      .values({ workspaceId, kind, payload: payload as object, status: 'queued' })
      .returning({ id: t.jobs.id });
    const jobId = row!.id;

    const done = this.queue.add(async () => {
      await this.db
        .update(t.jobs)
        .set({ status: 'running', startedAt: new Date() })
        .where(eq(t.jobs.id, jobId));
      try {
        await withRetry(
          () =>
            withTimeout(handler(payload, { jobId }), this.timeoutMs).then(async () => {
              await this.db
                .update(t.jobs)
                .set({ attempts: 1 })
                .where(eq(t.jobs.id, jobId));
            }),
          {
            retries: this.retries,
            onRetry: async (attempt) => {
              await this.db
                .update(t.jobs)
                .set({ attempts: attempt })
                .where(eq(t.jobs.id, jobId));
            },
          },
        );
        await this.db
          .update(t.jobs)
          .set({ status: 'done', finishedAt: new Date() })
          .where(eq(t.jobs.id, jobId));
      } catch (err) {
        await this.db
          .update(t.jobs)
          .set({
            status: 'failed',
            finishedAt: new Date(),
            error: (err as Error).message,
          })
          .where(eq(t.jobs.id, jobId));
        throw err;
      }
    }) as Promise<void>;

    // Fire-and-forget callers never await `done`; without a handler a failed job
    // is an unhandled rejection, which terminates the Node process. Observe it
    // here (callers that DO await `done` still see the rejection). The failure is
    // already persisted on the `jobs` row; the log carries no payload.
    done.catch((err: unknown) => this.reportFailure(jobId, kind, err));

    return { id: jobId, done };
  }

  private reportFailure(jobId: string, kind: string, err: unknown): void {
    try {
      const log = this.log;
      if (!log) return;
      const message = redactSecret(err instanceof Error ? err.message : String(err));
      const entry = { jobId, kind, err: message };
      if (log.error) log.error(entry, 'background job failed');
      else log.warn(entry, 'background job failed');
    } catch {
      // A throwing logger must not turn back into an unhandled rejection.
    }
  }

  /** Wait for the queue to drain (useful in tests). */
  async onIdle(): Promise<void> {
    await this.queue.onIdle();
  }
}
