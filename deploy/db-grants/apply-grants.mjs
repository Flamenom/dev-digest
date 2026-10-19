// Post-migration grant step, run by the one-shot `migrate` service AFTER
// `pnpm db:migrate && pnpm db:bootstrap` (deploy/compose.yml):
//
//   node /opt/devdigest/db-grants/apply-grants.mjs
//
// Applies deploy/db-grants/grants.sql (mounted read-only next to this file) as the
// owner role from DATABASE_URL. The runtime-role password comes from
// APP_DB_PASSWORD and reaches the SQL only as a bound parameter of
// set_config('devdigest.app_password', …) — it never appears in a statement text,
// a log line or this process's argv.
//
// The API image has no psql, so this reuses the server's own postgres-js driver.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(process.env.DEVDIGEST_SERVER_PKG ?? '/app/server/package.json');
const postgres = require('postgres');

const url = process.env.DATABASE_URL;
const appPassword = process.env.APP_DB_PASSWORD;
if (!url) {
  console.error('✗ grants: DATABASE_URL is required');
  process.exit(1);
}
if (!appPassword || appPassword.length < 16) {
  console.error('✗ grants: APP_DB_PASSWORD is missing or shorter than 16 characters');
  process.exit(1);
}
let ownerPassword = '';
try {
  ownerPassword = decodeURIComponent(new URL(url).password);
} catch {
  /* unparsable URL: the driver reports it below */
}
if (ownerPassword && ownerPassword === appPassword) {
  console.error('✗ grants: APP_DB_PASSWORD must differ from the owner password');
  process.exit(1);
}

const grantsSql = readFileSync(join(here, 'grants.sql'), 'utf8');
// One connection for the whole run: the GUC is session-scoped.
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await sql`select set_config('devdigest.app_password', ${appPassword}, false)`;
  // grants.sql is multi-statement (own BEGIN/COMMIT) → simple query protocol.
  await sql.unsafe(grantsSql).simple();
  await sql`select set_config('devdigest.app_password', '', false)`;
  console.log('✓ runtime-role grants applied (devdigest_app)');
} catch (err) {
  // Never print the error object wholesale: keep to the server's message/code.
  const e = /** @type {{ message?: string; code?: string }} */ (err);
  console.error(`✗ grants failed: ${e?.code ?? ''} ${e?.message ?? String(err)}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
