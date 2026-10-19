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
// Never echo a value: every message names the setting only.
// `openssl rand -hex 24` = 48 hex chars; URL-safe (embedded in DATABASE_URL).
const PLACEHOLDER = /replace-?me/i;
const STRONG = /^[A-Za-z0-9_-]{32,}$/;
const fail = (msg) => {
  console.error(`✗ grants: ${msg}`);
  process.exit(1);
};
if (!appPassword) fail('APP_DB_PASSWORD is missing');
if (PLACEHOLDER.test(appPassword))
  fail('APP_DB_PASSWORD is still the .env.example placeholder; generate one with: openssl rand -hex 24');
if (!STRONG.test(appPassword))
  fail('APP_DB_PASSWORD must be >= 32 chars of [A-Za-z0-9_-]; generate one with: openssl rand -hex 24');
let ownerPassword;
try {
  ownerPassword = decodeURIComponent(new URL(url).password);
} catch {
  fail('DATABASE_URL is not a valid postgres URL');
}
// The owner password comes from POSTGRES_PASSWORD (migrate's DATABASE_URL) and
// must meet the same bar as the runtime role's: the owner holds every right.
if (!ownerPassword) fail('POSTGRES_PASSWORD is missing (no password in DATABASE_URL)');
if (PLACEHOLDER.test(ownerPassword))
  fail('POSTGRES_PASSWORD is still the .env.example placeholder; generate one with: openssl rand -hex 24');
if (!STRONG.test(ownerPassword))
  fail('POSTGRES_PASSWORD must be >= 32 chars of [A-Za-z0-9_-]; generate one with: openssl rand -hex 24');
if (ownerPassword === appPassword)
  fail('APP_DB_PASSWORD must differ from POSTGRES_PASSWORD');

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
