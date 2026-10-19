/**
 * `pnpm secrets:import [--file <path>]` — one-time import of the legacy local
 * secrets JSON + legacy env vars into the encrypted store (AC-43, AC-44).
 *
 * Bootstrap entrypoint: loads config, builds the `Container` (composition root)
 * and hands plain dependencies to `modules/secrets/import.ts`. Runs against the
 * deploy database — it prints KEY NAMES only, never values, ciphertext or the
 * master key. Exit 0 on success, 1 on any failure (nothing written).
 */
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../platform/config.js';
import { ConfigError } from '../platform/errors.js';
import { Container } from '../platform/container.js';
import { createDb } from '../db/client.js';
import { SecretStoreRepository } from '../modules/secrets/repository.js';
import { AuditRepository } from '../modules/audit/repository.js';
import { SECRET_KEY_BY_PROVIDER } from '../platform/secret-keys.js';
import { runSecretsImport } from '../modules/secrets/import.js';

/** A config failure, printable without values (zod issues → paths only). */
function describeConfigError(err: unknown): string {
  if (err instanceof ConfigError) return err.message;
  if (err && typeof err === 'object' && Array.isArray((err as { issues?: unknown }).issues)) {
    const paths = (err as { issues: Array<{ path?: unknown[] }> }).issues.map((i) =>
      (i.path ?? []).join('.'),
    );
    return `invalid environment: ${[...new Set(paths)].join(', ')}`;
  }
  return 'could not load the server configuration';
}

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`secrets import failed: ${describeConfigError(err)}`);
    return 1;
  }
  if (config.authMode !== 'google' || !config.masterKey) {
    console.error(
      'secrets import failed: it targets the encrypted store — run it with AUTH_MODE=google and a ' +
        'valid SECRETS_MASTER_KEY',
    );
    return 1;
  }

  const handle = createDb(config.databaseUrl, { max: 1 });
  try {
    const container = new Container(config, handle.db);
    let workspaceId: string;
    try {
      workspaceId = (await container.auth.currentWorkspace({})).id;
    } catch {
      console.error('secrets import failed: no default workspace — run `pnpm db:bootstrap` first');
      return 1;
    }
    // TODO(T19): switch to the container's `secretStore` / `audit` getters once wired.
    return await runSecretsImport(
      process.argv.slice(2),
      {
        store: new SecretStoreRepository(container.db),
        audit: new AuditRepository(container.db),
        masterKey: config.masterKey,
        workspaceId,
        managedKeys: Object.values(SECRET_KEY_BY_PROVIDER),
        env: process.env,
        readSource: (path) => readFile(path, 'utf8'),
        actorUserId: null,
      },
      { out: (line) => console.log(line), err: (line) => console.error(line) },
    );
  } finally {
    await handle.close();
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    console.error('secrets import failed: unexpected error — nothing was written');
    process.exit(1);
  },
);
