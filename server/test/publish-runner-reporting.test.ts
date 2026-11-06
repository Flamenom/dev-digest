/**
 * AC-34 — a publish task failing with an internal error is reported once;
 * an upstream (ExternalServiceError) failure is not.
 */
import { describe, it, expect } from 'vitest';
import { PublishRunner } from '../src/modules/publish/runner.js';
import type { PublishRunInput } from '../src/modules/publish/executor.js';
import { ExternalServiceError } from '../src/platform/errors.js';
import type { ErrorReporter, ReportContext } from '../src/platform/error-reporting.js';

const input = (id: string) => ({ publicationId: id }) as PublishRunInput;
const log = { warn: () => {}, error: () => {} };

function recordingReporter() {
  const captures: Array<{ err: unknown; ctx?: ReportContext }> = [];
  const reporter: ErrorReporter = {
    capture: (err, ctx) => void captures.push({ err, ctx }),
    flush: async () => true,
  };
  return { reporter, captures };
}

describe('PublishRunner — error reporting', () => {
  it('captures an internal failure with jobKind publish', async () => {
    const { reporter, captures } = recordingReporter();
    const runner = new PublishRunner({
      executor: { run: async () => Promise.reject(new TypeError('bug')) },
      log,
      reporter,
    });
    runner.start(input('p1'));
    await runner.whenIdle();
    expect(captures).toHaveLength(1);
    expect(captures[0]!.ctx).toEqual({ jobKind: 'publish' });
  });

  it('does not capture an upstream ExternalServiceError', async () => {
    const { reporter, captures } = recordingReporter();
    const runner = new PublishRunner({
      executor: { run: async () => Promise.reject(new ExternalServiceError('gitlab down')) },
      log,
      reporter,
    });
    runner.start(input('p1'));
    await runner.whenIdle();
    expect(captures).toEqual([]);
  });

  it('a throwing reporter is contained', async () => {
    const runner = new PublishRunner({
      executor: { run: async () => Promise.reject(new Error('bug')) },
      log,
      reporter: {
        capture: () => {
          throw new Error('sentry exploded');
        },
        flush: async () => true,
      },
    });
    runner.start(input('p1'));
    await runner.whenIdle();
    expect(runner.isActive('p1')).toBe(false);
  });
});
