import { describe, expect, it } from 'vitest';
import {
  AppError,
  ConfigError,
  ExternalServiceError,
  NotFoundError,
  ValidationError,
} from '../src/platform/errors.js';
import { isReportable, NoopErrorReporter } from '../src/platform/error-reporting.js';

class FakeRunCancelledError extends Error {
  constructor() {
    super('Run cancelled');
    this.name = 'RunCancelledError';
  }
}

describe('isReportable — internal errors only (AC-34)', () => {
  const cases: Array<[string, unknown, boolean]> = [
    ['plain Error', new Error('boom'), true],
    ['TypeError', new TypeError('x is undefined'), true],
    ['non-Error throwable', 'string thrown', true],
    ['AppError 404 (NotFoundError)', new NotFoundError(), false],
    ['AppError 409', new AppError('conflict', 'c', 409), false],
    ['AppError 422 (ValidationError)', new ValidationError(), false],
    ['AppError 401', new AppError('unauthorized', 'u', 401), false],
    ['AppError 500', new AppError('x', 'internal', 500), true],
    ['ConfigError (500)', new ConfigError('bad config'), true],
    ['ExternalServiceError (502)', new ExternalServiceError('upstream down'), false],
    ['SDK-shaped 503 with headers', Object.assign(new Error('svc'), { status: 503, headers: {} }), false],
    ['SDK-shaped 429 with headers', { status: 429, headers: {}, message: 'rate' }, false],
    ['statusCode 400 (fastify-style)', Object.assign(new Error('bad'), { statusCode: 400 }), false],
    ['statusCode 500 without headers', Object.assign(new Error('bad'), { statusCode: 500 }), true],
    ['RunCancelledError by name', new FakeRunCancelledError(), false],
  ];

  it.each(cases)('%s → %s', (_label, err, expected) => {
    expect(isReportable(err)).toBe(expected);
  });
});

describe('NoopErrorReporter', () => {
  it('captures nothing and flushes immediately', async () => {
    const r = new NoopErrorReporter();
    expect(() => r.capture(new Error('x'), { route: '/x' })).not.toThrow();
    await expect(r.flush(2000)).resolves.toBe(true);
  });
});
