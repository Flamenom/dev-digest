import { request } from 'node:http';
import { inject } from 'vitest';
import { createDb, type DbHandle } from '../../src/db/client.js';

/**
 * Integration-test Postgres helper. Every fixture is a FRESH DATABASE in ONE
 * shared `pgvector/pgvector:pg16` cluster started lazily by
 * `test/global-setup.ts` (Task G7) — no container start per file.
 *
 *  - `startPg()`      → a database cloned from the migrated template (all
 *                       migrations applied once, at cluster start).
 *  - `startEmptyPg()` → an empty database (no migrations, no extensions) for
 *                       migration tests that apply a partial journal.
 *
 * `stop()` drops the database. Integration tests gate on `dockerAvailable()`
 * and skip cleanly when Docker is not reachable (CI/sandbox without a daemon).
 *
 * The broker is reached over `node:http` (not global `fetch`) so tests that stub
 * `fetch` cannot intercept fixture creation.
 */
export interface PgFixture {
  handle: DbHandle;
  url: string;
  stop: () => Promise<void>;
}

export interface EmptyPgFixture {
  url: string;
  stop: () => Promise<void>;
}

let dockerCache: boolean | undefined;

/** Cheap check: can we reach a Docker daemon? */
export async function dockerAvailable(): Promise<boolean> {
  if (dockerCache !== undefined) return dockerCache;
  try {
    const { execSync } = await import('node:child_process');
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    dockerCache = true;
  } catch {
    dockerCache = false;
  }
  return dockerCache;
}

function broker<T>(method: 'POST' | 'DELETE', path: string): Promise<T> {
  const { url, token } = inject('pgBroker');
  return new Promise<T>((resolve, reject) => {
    const req = request(
      new URL(path, url),
      { method, headers: { authorization: `Bearer ${token}` } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            return reject(new Error(`pg broker: bad response (${res.statusCode}): ${body}`));
          }
          if (res.statusCode !== 200) {
            const msg = (parsed as { error?: string }).error ?? body;
            return reject(new Error(`pg broker ${method} ${path} failed (${res.statusCode}): ${msg}`));
          }
          resolve(parsed as T);
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function createDatabase(kind: 'migrated' | 'empty'): Promise<EmptyPgFixture> {
  const { name, url } = await broker<{ name: string; url: string }>('POST', `/db?kind=${kind}`);
  let dropped = false;
  return {
    url,
    stop: async () => {
      if (dropped) return;
      dropped = true;
      await broker('DELETE', `/db/${name}`);
    },
  };
}

/** Fresh, fully-migrated database + a Drizzle client over it. */
export async function startPg(): Promise<PgFixture> {
  const db = await createDatabase('migrated');
  const handle = createDb(db.url, { max: 5 });
  return {
    handle,
    url: db.url,
    stop: async () => {
      await handle.close();
      await db.stop();
    },
  };
}

/** Fresh EMPTY database (no migrations, no `vector` extension). */
export function startEmptyPg(): Promise<EmptyPgFixture> {
  return createDatabase('empty');
}
