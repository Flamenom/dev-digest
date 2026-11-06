/**
 * AC-34 / AC-38 / AC-43 — the HTTP error handler reports internal 5xx errors
 * only, with the route template + internal user id, and the app flushes the
 * reporter on close. Hermetic: a recording fake reporter via ContainerOverrides.
 */
import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { AppError, ExternalServiceError } from '../src/platform/errors.js';
import type { ErrorReporter, ReportContext } from '../src/platform/error-reporting.js';
import { anonymous, asSession, buildHermeticGoogleApp } from './helpers/google-mode.js';

const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

class RecordingReporter implements ErrorReporter {
  captures: Array<{ err: unknown; ctx?: ReportContext }> = [];
  flushes: number[] = [];
  capture(err: unknown, ctx?: ReportContext): void {
    this.captures.push({ err, ctx });
  }
  async flush(timeoutMs: number): Promise<boolean> {
    this.flushes.push(timeoutMs);
    return true;
  }
}

describe('HTTP error reporting (local mode)', () => {
  it('captures exactly one event for a 5xx with route template + method; none for 4xx; flushes on close', async () => {
    const reporter = new RecordingReporter();
    const app = await buildApp({ config, overrides: { errorReporter: reporter } });
    app.get('/__boom/:id', async () => {
      throw new Error('internal failure');
    });
    app.get('/__conflict', async () => {
      throw new AppError('conflict', 'already there', 409);
    });
    app.get('/__upstream', async () => {
      throw new ExternalServiceError('upstream down');
    });
    await app.ready();

    const boom = await app.inject({ method: 'GET', url: '/__boom/42?code=SECRET-CODE&state=S' });
    expect(boom.statusCode).toBe(500);
    // Response body unchanged.
    expect(boom.json()).toEqual({ error: { code: 'internal_error', message: 'Internal error' } });
    expect(reporter.captures).toHaveLength(1);
    const [first] = reporter.captures;
    expect((first!.err as Error).message).toBe('internal failure');
    expect(first!.ctx).toEqual({ userId: undefined, route: '/__boom/:id', method: 'GET', status: 500 });
    expect(JSON.stringify(first!.ctx)).not.toContain('SECRET-CODE');

    reporter.captures.length = 0;
    expect((await app.inject({ method: 'GET', url: '/no/such/route' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/pulls/not-a-uuid/intent' })).statusCode).toBe(422);
    expect((await app.inject({ method: 'GET', url: '/__conflict' })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/__upstream' })).statusCode).toBe(502);
    expect(reporter.captures).toEqual([]);

    await app.close();
    expect(reporter.flushes).toHaveLength(1);
    expect(reporter.flushes[0]).toBeLessThanOrEqual(2000);
  });

  it('a throwing reporter never changes the response', async () => {
    const reporter: ErrorReporter = {
      capture: () => {
        throw new Error('sentry exploded');
      },
      flush: async () => true,
    };
    const app = await buildApp({ config, overrides: { errorReporter: reporter } });
    app.get('/__boom', async () => {
      throw new Error('internal failure');
    });
    const res = await app.inject({ method: 'GET', url: '/__boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'internal_error', message: 'Internal error' } });
    await app.close();
  });
});

describe('HTTP error reporting (google mode)', () => {
  it('a 401 is not captured; a signed-in 5xx carries the internal user id and nothing else identifying', async () => {
    const reporter = new RecordingReporter();
    const repoService = {
      registerCloneJobHandler: () => undefined,
      list: async () => {
        throw new Error('list exploded');
      },
    };
    const t = await buildHermeticGoogleApp({
      overrides: { errorReporter: reporter, repoService: repoService as never },
    });
    try {
      const anon = await t.app.inject(anonymous({ method: 'GET', url: '/repos' }));
      expect(anon.statusCode).toBe(401);
      expect(reporter.captures).toEqual([]);

      const cred = t.principals.session('member');
      const res = await t.app.inject(asSession(cred, { method: 'GET', url: '/repos' }));
      expect(res.statusCode).toBe(500);
      expect(reporter.captures).toHaveLength(1);
      expect(reporter.captures[0]!.ctx).toEqual({
        userId: cred.principal.userId,
        route: '/repos',
        method: 'GET',
        status: 500,
      });
      expect(JSON.stringify(reporter.captures[0]!.ctx)).not.toContain(cred.sessionId);
    } finally {
      await t.close();
    }
  });
});
