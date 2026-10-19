import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { recordingDb } from './helpers/google-mode.js';

/**
 * AC-4 (boot half): the ACKNOWLEDGED local-in-production path
 * (`NODE_ENV=production` + `ALLOW_UNAUTHENTICATED_LOCAL_MODE=true`, AUTH_MODE
 * unset → local) boots, but logs exactly one loud warn naming the settings.
 *
 * The config half — production + local WITHOUT the acknowledgement is refused
 * by `loadConfig` — is covered in `config-auth-mode.test.ts`
 * ("refuses local mode in production unless acknowledged"); not duplicated here.
 *
 * Hermetic: env built from scratch (no `process.env`), recording DB proxy
 * (boot-time stale-run reaping fails non-fatally against it).
 */
const ACK_MARKER = 'API is UNAUTHENTICATED';

interface LogLine {
  level: number;
  msg?: string;
}

describe('local mode in production, acknowledged (AC-4)', () => {
  let app: FastifyInstance;
  const lines: string[] = [];
  const parsed = (): LogLine[] => lines.map((l) => JSON.parse(l) as LogLine);

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      ALLOW_UNAUTHENTICATED_LOCAL_MODE: 'true',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/none',
    } as NodeJS.ProcessEnv);
    expect(config.authMode).toBe('local');
    app = await buildApp({
      config,
      db: recordingDb().db,
      logStream: { write: (line) => void lines.push(line) },
    });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
  });

  it('logs the unauthenticated-mode warning once, at warn level', () => {
    const hits = parsed().filter((l) => l.msg?.includes(ACK_MARKER));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.level).toBe(40); // pino "warn"
  });

  it('names the settings involved', () => {
    const msg = parsed().find((l) => l.msg?.includes(ACK_MARKER))!.msg!;
    expect(msg).toContain('AUTH_MODE');
    expect(msg).toContain('NODE_ENV');
    expect(msg).toContain('ALLOW_UNAUTHENTICATED_LOCAL_MODE');
    // No secrets/infrastructure values leak into the warning.
    expect(msg).not.toContain('postgres://');
    expect(msg).not.toContain('nobody');
  });

  it('still serves requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
