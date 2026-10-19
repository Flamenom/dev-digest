import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import * as t from '../src/db/schema.js';
import { SecretStoreRepository } from '../src/modules/secrets/repository.js';
import { AuditRepository } from '../src/modules/audit/repository.js';
import { EncryptedSecretsProvider } from '../src/adapters/secrets/encrypted.js';
import { runSecretsImport, type SecretsImportDeps } from '../src/modules/secrets/import.js';
import type { SecretsTx } from '../src/modules/secrets/repository.js';

/**
 * T11 — one-time secrets import against Postgres (AC-43, AC-44): idempotent,
 * never overwrites, ignores unknown keys, leaves the source file unchanged,
 * audits, is all-or-nothing, and prints key names only. All values are
 * synthetic and live in a temp file created by this test.
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const MANAGED = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GITHUB_TOKEN', 'GITLAB_TOKEN'];
const FILE_VALUES = {
  OPENAI_API_KEY: 'synthetic-file-openai-1111',
  ANTHROPIC_API_KEY: 'synthetic-file-anthropic-2222',
  OPENROUTER_API_KEY: 'synthetic-file-openrouter-3333',
  SOME_UNKNOWN_KEY: 'synthetic-file-unknown-4444',
};
const ENV = {
  GITHUB_PAT: 'synthetic-env-github-5555',
  GITLAB_TOKEN: 'synthetic-env-gitlab-6666',
  // A file value wins over the same-named env var (LocalSecretsProvider precedence).
  OPENAI_API_KEY: 'synthetic-env-openai-7777',
};
const ALL_VALUES = [...Object.values(FILE_VALUES), ...Object.values(ENV)];

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

const sha = async (p: string) => createHash('sha256').update(await readFile(p)).digest('hex');

d('secrets import (Postgres)', () => {
  let pg: PgFixture;
  let store: SecretStoreRepository;
  let audit: AuditRepository;
  let workspaceId: string;
  let dir: string;
  let file: string;
  const masterKey = randomBytes(32);

  beforeAll(async () => {
    pg = await startPg();
    store = new SecretStoreRepository(pg.handle.db);
    audit = new AuditRepository(pg.handle.db);
    dir = await mkdtemp(join(tmpdir(), 'devdigest-import-'));
    file = join(dir, 'secrets.json');
    await writeFile(file, `${JSON.stringify(FILE_VALUES, null, 2)}\n`, { mode: 0o600 });
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const [ws] = await pg.handle.db
      .insert(t.workspaces)
      .values({ name: `import-ws-${randomBytes(4).toString('hex')}` })
      .returning();
    workspaceId = ws!.id;
  });

  const deps = (over: Partial<SecretsImportDeps<SecretsTx>> = {}): SecretsImportDeps<SecretsTx> => ({
    store,
    audit,
    masterKey,
    workspaceId,
    managedKeys: MANAGED,
    env: ENV,
    readSource: (p) => readFile(p, 'utf8'),
    actorUserId: null,
    ...over,
  });

  const provider = () => new EncryptedSecretsProvider({ store, masterKey, workspaceId, managedKeys: MANAGED });

  it('imports file + env, then a second run skips all; a UI-set key is never overwritten; file unchanged', async () => {
    const checksum = await sha(file);

    const first = io();
    expect(await runSecretsImport(['--file', file], deps(), first.io)).toBe(0);
    expect(first.out).toContain(
      'imported: OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, GITHUB_TOKEN, GITLAB_TOKEN',
    );
    expect(first.out).toContain('ignored (unknown key names): SOME_UNKNOWN_KEY');

    const p = provider();
    expect(await p.get('OPENAI_API_KEY')).toBe(FILE_VALUES.OPENAI_API_KEY);
    expect(await p.get('GITHUB_TOKEN')).toBe(ENV.GITHUB_PAT);
    expect(await p.get('GITLAB_TOKEN')).toBe(ENV.GITLAB_TOKEN);

    // An Admin edits a key in the UI between runs.
    await p.set('OPENROUTER_API_KEY', 'synthetic-ui-edited-8888');

    const second = io();
    expect(await runSecretsImport([`--file=${file}`], deps(), second.io)).toBe(0);
    expect(second.out).toContain('imported: (none)');
    expect(second.out).toContain(
      'skipped (already stored, not overwritten): OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, GITHUB_TOKEN, GITLAB_TOKEN',
    );
    expect(await p.get('OPENROUTER_API_KEY')).toBe('synthetic-ui-edited-8888');

    expect(await sha(file)).toBe(checksum);

    const events = await pg.handle.db
      .select()
      .from(t.auditEvents)
      .where(eq(t.auditEvents.workspaceId, workspaceId));
    const imports = events.filter((e) => e.action === 'secrets.import');
    expect(imports).toHaveLength(2);

    const output = [...first.out, ...first.err, ...second.out, ...second.err, JSON.stringify(events)].join('\n');
    for (const v of [...ALL_VALUES, 'synthetic-ui-edited-8888']) expect(output).not.toContain(v);
    expect(output).not.toContain(masterKey.toString('base64'));
  });

  it('an injected failure on the 3rd key rolls back everything (0 rows), exits 1, prints no values', async () => {
    let calls = 0;
    const failing = new Proxy(store, {
      get(target, prop, recv) {
        if (prop === 'insertIfAbsent') {
          return async (...args: Parameters<SecretStoreRepository['insertIfAbsent']>) => {
            calls++;
            if (calls === 3) throw Object.assign(new Error(`boom ${FILE_VALUES.OPENROUTER_API_KEY}`), { code: 'XX000' });
            return target.insertIfAbsent(...args);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });
    const r = io();
    expect(await runSecretsImport(['--file', file], deps({ store: failing }), r.io)).toBe(1);
    expect(calls).toBe(3);
    expect(await store.list(workspaceId)).toHaveLength(0);
    const output = [...r.out, ...r.err].join('\n');
    for (const v of ALL_VALUES) expect(output).not.toContain(v);
    expect(r.err.join('\n')).toMatch(/rolled back/);
  });

  it('invalid JSON → exit non-zero, 0 rows, no audit; missing master key → exit non-zero', async () => {
    const bad = join(dir, 'bad.json');
    await writeFile(bad, `{"OPENAI_API_KEY": "synthetic-broken-9999",`, { mode: 0o600 });
    const r = io();
    expect(await runSecretsImport(['--file', bad], deps(), r.io)).toBe(1);
    expect(r.err.join('\n')).toMatch(/not valid JSON/);
    expect(r.err.join('\n')).not.toContain('synthetic-broken-9999');
    expect(await store.list(workspaceId)).toHaveLength(0);

    const noKey = io();
    expect(await runSecretsImport(['--file', file], deps({ masterKey: null }), noKey.io)).toBe(1);
    expect(noKey.err.join('\n')).toMatch(/SECRETS_MASTER_KEY/);
    expect(await store.list(workspaceId)).toHaveLength(0);

    const events = await pg.handle.db
      .select()
      .from(t.auditEvents)
      .where(eq(t.auditEvents.workspaceId, workspaceId));
    expect(events).toHaveLength(0);
  });
});
