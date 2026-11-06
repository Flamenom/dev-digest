import { beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => {
  const scope = { setUser: vi.fn(), setTag: vi.fn() };
  return {
    scope,
    init: vi.fn(),
    withScope: vi.fn((cb: (s: typeof scope) => void) => cb(scope)),
    captureException: vi.fn(),
    flush: vi.fn(async () => true),
    linkedErrorsIntegration: vi.fn(() => ({ name: 'LinkedErrors' })),
    dedupeIntegration: vi.fn(() => ({ name: 'Dedupe' })),
  };
});
vi.mock('@sentry/node', () => sentry);

import { createSentryReporter } from '../src/adapters/sentry/sentry-reporter.js';

const VALID_DSN = 'https://publickey123@o42.ingest.sentry.io/4507';

function logger() {
  const lines: string[] = [];
  return { lines, log: { warn: (m: string) => void lines.push(m) } };
}

beforeEach(() => {
  vi.clearAllMocks();
  sentry.withScope.mockImplementation((cb) => cb(sentry.scope));
  sentry.flush.mockImplementation(async () => true);
});

describe('createSentryReporter', () => {
  it.each([
    'not a dsn',
    'ftp://key@sentry.io/1',
    'https://sentry.io/123', // no public key
    'https://key@sentry.io/project', // non-numeric project id
  ])('malformed DSN %s → Noop, init never called, one warning without the value', async (dsn) => {
    const { lines, log } = logger();
    const r = createSentryReporter({ dsn, environment: 'production', release: 'abc', log });
    expect(sentry.init).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('SENTRY_DSN');
    expect(lines[0]).not.toContain(dsn);
    r.capture(new Error('x'));
    expect(sentry.captureException).not.toHaveBeenCalled();
    await expect(r.flush(10)).resolves.toBe(true);
  });

  it('valid DSN → errors-only init with privacy options (AC-36/39/40)', () => {
    const { lines, log } = logger();
    createSentryReporter({ dsn: VALID_DSN, environment: 'staging', release: 'deadbeef', log });
    expect(lines).toHaveLength(0);
    expect(sentry.init).toHaveBeenCalledTimes(1);
    const o = sentry.init.mock.calls[0]![0] as Record<string, unknown>;

    expect(o.dsn).toBe(VALID_DSN);
    expect(o.release).toBe('deadbeef');
    expect(o.environment).toBe('staging');

    for (const k of ['tracesSampleRate', 'profilesSampleRate', 'profileSessionSampleRate']) {
      expect([undefined, 0]).toContain(o[k]);
    }
    expect(o.tracesSampler).toBeUndefined();
    expect(o.sendDefaultPii).not.toBe(true);
    expect(o.includeLocalVariables).toBe(false);
    expect(o.enableOpenTelemetrySetup).toBe(false);
    expect(o.defaultIntegrations).toBe(false);
    expect(o.maxBreadcrumbs).toBe(0);
    expect((o.beforeBreadcrumb as () => unknown)()).toBeNull();
    expect(o.dataCollection).toEqual(
      expect.objectContaining({
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        stackFrameVariables: false,
      }),
    );

    const names = (o.integrations as Array<{ name: string }>).map((i) => i.name);
    for (const banned of ['Replay', 'Http', 'OnUncaughtException', 'OnUnhandledRejection', 'LocalVariables']) {
      expect(names).not.toContain(banned);
    }
    expect((o.transportOptions as { bufferSize: number }).bufferSize).toBeGreaterThan(0);
  });

  it('beforeSend scrubs with the injected secrets', () => {
    const { log } = logger();
    createSentryReporter({
      dsn: VALID_DSN,
      environment: 'production',
      release: 'unknown',
      log,
      secrets: () => ['SuperSecretDbPw'],
    });
    const o = sentry.init.mock.calls[0]![0] as { beforeSend: (e: unknown, h: unknown) => unknown };
    const out = o.beforeSend(
      {
        message: 'conn failed for SuperSecretDbPw',
        user: { id: 'u1', email: 'a@b.c' },
        request: { headers: { Authorization: 'Bearer x' } },
      },
      {},
    );
    expect(JSON.stringify(out)).not.toContain('SuperSecretDbPw');
    expect((out as { user: unknown }).user).toEqual({ id: 'u1' });
  });

  it('capture sets user id + tags and captures', () => {
    const { log } = logger();
    const r = createSentryReporter({ dsn: VALID_DSN, environment: 'p', release: 'r', log });
    const err = new Error('boom');
    r.capture(err, { userId: 'u1', route: '/pulls/:id', method: 'POST', status: 500, jobKind: 'review', runId: 'run1' });
    expect(sentry.scope.setUser).toHaveBeenCalledWith({ id: 'u1' });
    expect(sentry.scope.setTag).toHaveBeenCalledWith('route', '/pulls/:id');
    expect(sentry.scope.setTag).toHaveBeenCalledWith('method', 'POST');
    expect(sentry.scope.setTag).toHaveBeenCalledWith('status', '500');
    expect(sentry.scope.setTag).toHaveBeenCalledWith('job_kind', 'review');
    expect(sentry.scope.setTag).toHaveBeenCalledWith('run_id', 'run1');
    expect(sentry.captureException).toHaveBeenCalledWith(err);
  });

  it('capture never throws even if the SDK does (AC-42)', () => {
    const { log } = logger();
    const r = createSentryReporter({ dsn: VALID_DSN, environment: 'p', release: 'r', log });
    sentry.captureException.mockImplementation(() => {
      throw new Error('sdk exploded');
    });
    expect(() => r.capture(new Error('x'))).not.toThrow();
    sentry.withScope.mockImplementation(() => {
      throw new Error('scope exploded');
    });
    expect(() => r.capture(new Error('x'))).not.toThrow();
  });

  it('flush resolves even if Sentry.flush rejects', async () => {
    const { log } = logger();
    const r = createSentryReporter({ dsn: VALID_DSN, environment: 'p', release: 'r', log });
    sentry.flush.mockImplementation(async () => {
      throw new Error('network');
    });
    await expect(r.flush(2000)).resolves.toBe(false);
    sentry.flush.mockImplementation(async () => true);
    await expect(r.flush(2000)).resolves.toBe(true);
  });

  it('init throwing → Noop + one warning, no throw', () => {
    const { lines, log } = logger();
    sentry.init.mockImplementationOnce(() => {
      throw new Error('init failed');
    });
    const r = createSentryReporter({ dsn: VALID_DSN, environment: 'p', release: 'r', log });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(VALID_DSN);
    expect(() => r.capture(new Error('x'))).not.toThrow();
  });
});
