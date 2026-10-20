import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { GlobalSetupContext } from 'vitest/node';
import { runMigrations } from '../src/db/migrate.js';

/**
 * Vitest globalSetup — ONE shared Postgres cluster for every `*.it.test.ts`
 * file, with a fresh DATABASE per fixture (Task G7).
 *
 * Why: ~24 it-suites each starting their own container (up to 10 at once)
 * pushed a `beforeAll` past the 120 s hookTimeout under Docker load.
 *
 * Laziness: this file runs in the main vitest process for EVERY run, including
 * hermetic-only runs, so it must not touch Docker eagerly. It only starts a tiny
 * loopback HTTP "broker" (no Docker, ~1 ms) and provides its address + a random
 * token to workers via `provide('pgBroker')`. The container is started on the
 * FIRST database request (single-flight promise), i.e. only when an it-test's
 * `beforeAll` actually calls `startPg()` / `startEmptyPg()`. A hermetic-only run
 * never sends a request → never starts a container.
 *
 * Per-database isolation:
 *  - `POST /db?kind=migrated` → `CREATE DATABASE <new> TEMPLATE devdigest_template`
 *    (the template is migrated once, when the cluster starts).
 *  - `POST /db?kind=empty`    → `CREATE DATABASE <new> TEMPLATE template0`
 *    (for migration tests that apply a partial journal themselves).
 *  - `DELETE /db/<name>`      → `DROP DATABASE ... WITH (FORCE)`.
 * Migrations create no roles/grants (only `CREATE EXTENSION vector` + schema),
 * so nothing cluster-wide leaks between databases; the extension is per-DB and
 * copied with the template. Advisory locks are per-database in Postgres.
 *
 * Teardown stops the container (if it was started) and closes the broker.
 */

export const PG_IMAGE = 'pgvector/pgvector:pg16';
const TEMPLATE_DB = 'devdigest_template';

interface Cluster {
  container: StartedPostgreSqlContainer;
  admin: postgres.Sql;
  /** Connection URI with the database name swapped. */
  urlFor: (db: string) => string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgBroker: { url: string; token: string };
  }
}

export default async function setup({ provide }: GlobalSetupContext) {
  let clusterPromise: Promise<Cluster> | undefined;
  const created = new Set<string>();
  let seq = 0;

  async function startCluster(): Promise<Cluster> {
    const container = await new PostgreSqlContainer(PG_IMAGE)
      .withDatabase('devdigest')
      .withUsername('devdigest')
      .withPassword('devdigest')
      // Test-only cluster: many parallel per-file pools, durability not needed.
      .withCommand([
        'postgres',
        '-c', 'max_connections=1000',
        '-c', 'fsync=off',
        '-c', 'synchronous_commit=off',
        '-c', 'full_page_writes=off',
      ])
      .start();
    const base = new URL(container.getConnectionUri());
    const urlFor = (db: string) => {
      const u = new URL(base.toString());
      u.pathname = `/${db}`;
      return u.toString();
    };
    const admin = postgres(urlFor('postgres'), { max: 4, onnotice: () => {} });
    try {
      await admin.unsafe(`CREATE DATABASE "${TEMPLATE_DB}"`);
      await runMigrations(urlFor(TEMPLATE_DB));
      // runMigrations closed its connection; lock the template so nothing can
      // connect to it (CREATE DATABASE ... TEMPLATE fails if it has sessions).
      await admin.unsafe(
        `ALTER DATABASE "${TEMPLATE_DB}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
      );
    } catch (err) {
      await admin.end({ timeout: 5 }).catch(() => undefined);
      await container.stop().catch(() => undefined);
      throw err;
    }
    return { container, admin, urlFor };
  }

  const cluster = () => (clusterPromise ??= startCluster());

  async function createDatabase(kind: 'migrated' | 'empty'): Promise<{ name: string; url: string }> {
    const c = await cluster();
    // Server-generated identifier only — never derived from the request.
    const name = `t_${process.pid}_${++seq}_${randomBytes(3).toString('hex')}`;
    const template = kind === 'migrated' ? TEMPLATE_DB : 'template0';
    await c.admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
    created.add(name);
    return { name, url: c.urlFor(name) };
  }

  async function dropDatabase(name: string): Promise<void> {
    if (!created.has(name) || !clusterPromise) return;
    const c = await clusterPromise;
    await c.admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    created.delete(name);
  }

  const token = randomBytes(24).toString('hex');

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'unauthorized' });
      const url = new URL(req.url ?? '/', 'http://broker');
      try {
        if (req.method === 'POST' && url.pathname === '/db') {
          const kind = url.searchParams.get('kind') === 'empty' ? 'empty' : 'migrated';
          return send(res, 200, await createDatabase(kind));
        }
        const m = /^\/db\/([a-z0-9_]+)$/.exec(url.pathname);
        if (req.method === 'DELETE' && m) {
          await dropDatabase(m[1]!);
          return send(res, 200, { ok: true });
        }
        return send(res, 404, { error: 'not_found' });
      } catch (err) {
        return send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
  // Many workers wait on the first (container-starting) request concurrently.
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  provide('pgBroker', { url: `http://127.0.0.1:${port}`, token });

  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!clusterPromise) return;
    const c = await clusterPromise.catch(() => undefined);
    if (!c) return;
    await c.admin.end({ timeout: 5 }).catch(() => undefined);
    await c.container.stop();
  };
}
