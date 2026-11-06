import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/platform/config.js';

/** Hermetic: env built from scratch so a developer's `.env` cannot leak in. */
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ NODE_ENV: 'test', ...extra }) as NodeJS.ProcessEnv;

describe('config — Sentry settings', () => {
  it('defaults: no DSN, environment production, release unknown', () => {
    const c = loadConfig(env());
    expect(c.sentryDsn).toBeNull();
    expect(c.sentryEnvironment).toBe('production');
    expect(c.sentryRelease).toBe('unknown');
  });

  it("treats '' and whitespace-only values as unset", () => {
    const c = loadConfig(env({ SENTRY_DSN: '', SENTRY_ENVIRONMENT: '  ', SENTRY_RELEASE: '' }));
    expect(c.sentryDsn).toBeNull();
    expect(c.sentryEnvironment).toBe('production');
    expect(c.sentryRelease).toBe('unknown');
  });

  it('passes set values through (trimmed) without validating the DSN shape', () => {
    const c = loadConfig(
      env({
        SENTRY_DSN: ' https://abc@o1.ingest.sentry.io/123 ',
        SENTRY_ENVIRONMENT: 'staging',
        SENTRY_RELEASE: '0123456789abcdef',
      }),
    );
    expect(c.sentryDsn).toBe('https://abc@o1.ingest.sentry.io/123');
    expect(c.sentryEnvironment).toBe('staging');
    expect(c.sentryRelease).toBe('0123456789abcdef');
    // A malformed DSN never fails config loading (the adapter degrades instead).
    expect(loadConfig(env({ SENTRY_DSN: 'not a dsn' })).sentryDsn).toBe('not a dsn');
  });
});
