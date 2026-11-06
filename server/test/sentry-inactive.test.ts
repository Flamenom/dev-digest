/**
 * AC-32 — with no DSN (or NODE_ENV=test) no reporter is initialised and the
 * process gets no extra crash handlers: behaviour is exactly as before.
 */
import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { NoopErrorReporter } from '../src/platform/error-reporting.js';

describe('Sentry inactive', () => {
  it('no DSN → Noop reporter, inactive, no process listeners added', async () => {
    const env = { ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv;
    delete env.SENTRY_DSN;
    const config = loadConfig(env);
    expect(config.sentryDsn).toBeNull();

    const before = {
      ue: process.listenerCount('uncaughtException'),
      ur: process.listenerCount('unhandledRejection'),
    };
    const app = await buildApp({ config });
    await app.ready();
    expect(app.container.errorReporter).toBeInstanceOf(NoopErrorReporter);
    expect(app.container.errorReporterActive).toBe(false);
    expect(process.listenerCount('uncaughtException')).toBe(before.ue);
    expect(process.listenerCount('unhandledRejection')).toBe(before.ur);
    await app.close();
  });

  it('a DSN under NODE_ENV=test is ignored (D-12)', async () => {
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      SENTRY_DSN: 'https://public@o1.ingest.sentry.io/123',
    } as NodeJS.ProcessEnv);
    expect(config.sentryDsn).not.toBeNull();
    const app = await buildApp({ config });
    expect(app.container.errorReporterActive).toBe(false);
    await app.close();
  });
});
