import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { loadConfig, type AppConfig } from './platform/config.js';
import { ConfigError } from './platform/errors.js';
import { redactSecret } from './platform/redact.js';

/** Max wait for the crash report to leave before exiting (AC-43). */
const CRASH_FLUSH_MS = 2_000;

/**
 * A boot-time configuration failure (invalid settings, AC-1/3/4; another
 * instance holds the DB claim, AC-5). Matched by class AND shape so a
 * ConfigError from a duplicated module instance is still recognised.
 */
function isConfigError(err: unknown): err is { message: string } {
  return (
    err instanceof ConfigError ||
    (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'config_error')
  );
}

/**
 * Print a config failure to stderr and exit non-zero. The message names the
 * offending settings — never their values (validateAuthConfig guarantees it).
 */
function exitOnConfigError(err: unknown): never {
  if (isConfigError(err)) {
    process.stderr.write(`DevDigest API refused to start: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

/**
 * AC-34 — report uncaught exceptions / unhandled rejections, then keep today's
 * crash semantics (log + exit 1). Installed ONLY when a reporter is active, so
 * with no DSN the process behaves exactly as before (Node's defaults, AC-32).
 */
function installCrashReporting(app: FastifyInstance): void {
  const reporter = app.container.errorReporter;
  let crashing = false;
  const crash = (kind: 'uncaughtException' | 'unhandledRejection') => async (err: unknown) => {
    if (crashing) return;
    crashing = true;
    try {
      reporter.capture(err, { jobKind: kind });
      await reporter.flush(CRASH_FLUSH_MS);
    } catch {
      // the port never throws; belt and braces — the exit below must happen
    }
    try {
      const message = redactSecret(err instanceof Error ? err.message : String(err));
      app.log.fatal({ err: message }, kind);
    } finally {
      process.exit(1);
    }
  };
  process.on('uncaughtException', crash('uncaughtException'));
  process.on('unhandledRejection', crash('unhandledRejection'));
}

/** Production/dev entrypoint. `pnpm dev` runs `tsx watch src/server.ts`. */
async function main() {
  let config: AppConfig;
  let app: FastifyInstance;
  try {
    config = loadConfig();
    app = await buildApp({ config });
  } catch (err) {
    exitOnConfigError(err);
  }

  if (app.container.errorReporterActive) installCrashReporting(app);

  // Graceful shutdown: on SIGTERM/SIGINT close the server, which runs the
  // onClose hooks (drains in-flight requests/SSE, closes the postgres pool).
  // Guarded so a second signal during shutdown doesn't double-close.
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, async () => {
      if (closing) return;
      closing = true;
      app.log.info(`${signal} received — shutting down`);
      try {
        await app.close();
        process.exit(0);
      } catch (err) {
        app.log.error(err, 'error during shutdown');
        process.exit(1);
      }
    });
  }

  try {
    await app.listen({ port: config.apiPort, host: config.apiHost });
    app.log.info(`DevDigest API listening on http://${config.apiHost}:${config.apiPort}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
