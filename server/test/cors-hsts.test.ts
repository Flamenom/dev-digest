import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { buildHermeticGoogleApp, HERMETIC_DATABASE_URL, TEST_ORIGIN, type HermeticGoogleApp } from './helpers/google-mode.js';

/**
 * AC-51 — credentialed CORS only for the public origin (google mode).
 * AC-62 — Strict-Transport-Security in google mode.
 * Local mode keeps its localhost web origin (AC-2).
 */

const preflight = (origin: string) => ({
  method: 'OPTIONS' as const,
  url: '/repos',
  headers: {
    origin,
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'content-type,x-devdigest-csrf',
  },
});

describe('CORS + HSTS (google mode)', () => {
  let t: HermeticGoogleApp;
  beforeAll(async () => {
    t = await buildHermeticGoogleApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('a preflight from another origin gets no Access-Control-Allow-Origin', async () => {
    const res = await t.app.inject(preflight('https://evil.example'));
    // (@fastify/cors still emits Allow-Credentials; without ACAO the browser blocks the request.)
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a preflight from the public origin is allowed with credentials', async () => {
    const res = await t.app.inject(preflight(TEST_ORIGIN));
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('a credentialed request from another origin carries no ACAO (and is still 401)', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/repos', headers: { origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('error answers to the public origin still carry the CORS headers', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/repos', headers: { origin: TEST_ORIGIN } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
  });

  it('sends Strict-Transport-Security (one year, subdomains)', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    const hsts = String(res.headers['strict-transport-security']);
    expect(hsts).toContain('max-age=31536000');
    expect(hsts).toContain('includeSubDomains');
    // The existing security headers stay.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('CORS (local mode, unchanged)', () => {
  it('allows only the localhost web origin', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: HERMETIC_DATABASE_URL,
    } as NodeJS.ProcessEnv);
    const app = await buildApp({ config });
    try {
      const ok = await app.inject(preflight('http://localhost:3000'));
      expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      const bad = await app.inject(preflight('https://evil.example'));
      expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
