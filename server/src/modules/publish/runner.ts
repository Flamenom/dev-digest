/**
 * In-process background tasks for publications (plan "Background execution —
 * decision", Rec1; spec AC-21, AC-34). Application ring.
 *
 * NOT `JobRunner`: its `withRetry` would re-run the handler and re-send
 * non-idempotent draft creates / `bulk_publish` (AC-30, AC-32), its timeout
 * would reject while the handler keeps running, and its queue is shared with
 * clone/index jobs. A publication is a single detached promise here.
 */
import type { PublishRunInput } from './executor.js';
import type { PublishLogger } from './ports.js';
import { errorCode } from './reconciler.js';

export interface PublishRunnerDeps {
  executor: { run: (input: PublishRunInput) => Promise<void> };
  log: PublishLogger;
}

export class PublishRunner {
  private readonly live = new Map<string, Promise<void>>();

  constructor(private readonly deps: PublishRunnerDeps) {}

  /**
   * Starts the publish in the background and returns immediately (the 202 path
   * never awaits it). Never throws; a second start of a live publication is ignored.
   */
  start(input: PublishRunInput): void {
    const id = input.publicationId;
    if (this.live.has(id)) {
      this.deps.log.warn({ publicationId: id }, 'publish task already running');
      return;
    }
    const task = Promise.resolve()
      .then(() => this.deps.executor.run(input))
      .catch((err: unknown) => {
        this.deps.log.error({ publicationId: id, code: errorCode(err) }, 'publish task failed');
      })
      .finally(() => {
        this.live.delete(id);
      });
    this.live.set(id, task);
  }

  /** Whether this process is still running the publication (the reconciler skips it). */
  isActive(publicationId: string): boolean {
    return this.live.has(publicationId);
  }

  /** Resolves when no task is live (tests, `onClose`). */
  async whenIdle(): Promise<void> {
    while (this.live.size > 0) await Promise.allSettled([...this.live.values()]);
  }
}
