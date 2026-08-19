import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockLLMProvider } from '../src/adapters/mocks.js';
import type { GitClient, RepoRef, RepoIntel } from '@devdigest/shared';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  console.warn('[conventions] Docker not available — skipping integration tests.');
}

/**
 * Conventions Extractor against a real Postgres: the 0013 migration applies,
 * extract persists grounded pending rows + the per-repo scan row (upsert), a
 * re-scan replaces previous candidates, accept/reject keeps the
 * `accepted === (status === 'accepted')` dual-write invariant, bulk deselect,
 * repo-cascade cleanup, and POST /skills carrying `evidence_files`.
 */
d('conventions module (integration)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let repoId: string;

  const USERS_TS =
    'export async function getUser(id: string) {\n' +
    '  const user = await db.users.find(id);\n' +
    '  return user;\n' +
    '}\n';

  const CLONE_FILES: Record<string, string> = {
    'package.json': '{ "type": "module" }\n',
    'src/api/users.ts': USERS_TS,
  };

  const fakeGit = {
    readFile: async (_repo: RepoRef, path: string) => {
      const content = CLONE_FILES[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  } as unknown as GitClient;

  const fakeRepoIntel = {
    getConventionSamples: async () => ['src/api/users.ts'],
  } as unknown as RepoIntel;

  const EXTRACTION_FIXTURE = {
    conventions: [
      {
        category: 'error-handling',
        rule: 'Always use async/await instead of .then() chains',
        evidence_path: 'src/api/users.ts',
        evidence_snippet: '  const user = await db.users.find(id);',
        confidence: 0.91,
      },
      {
        category: 'structure',
        rule: 'Fabricated — must be dropped by grounding',
        evidence_path: 'src/api/users.ts',
        evidence_snippet: 'const fabricated = neverInFile();',
        confidence: 0.5,
      },
    ],
  };

  beforeAll(async () => {
    pg = await startPg();
    const seeded = await seed(pg.handle.db);
    workspaceId = seeded.workspaceId;
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name: 'conv-lab', fullName: 'acme/conv-lab' })
      .returning();
    repoId = repo!.id;
  });
  afterAll(async () => {
    await pg?.stop();
  });

  function makeApp() {
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    return buildApp({
      config,
      db: pg.handle.db,
      overrides: {
        git: fakeGit,
        repoIntel: fakeRepoIntel,
        llm: {
          openai: new MockLLMProvider('openai', {
            structuredBySchema: {
              ConventionFileSelection: { files: ['src/api/users.ts'] },
              ConventionExtraction: EXTRACTION_FIXTURE,
            },
          }),
        },
      },
    });
  }

  it('extract → grounded pending rows + scan stats; list mirrors them', async () => {
    const app = await makeApp();

    const res = await app.inject({
      method: 'POST',
      url: `/repos/${repoId}/conventions/extract`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.conventions).toHaveLength(1); // fabricated candidate dropped
    expect(body.conventions[0]).toMatchObject({
      rule: 'Always use async/await instead of .then() chains',
      status: 'pending',
      evidence_path: 'src/api/users.ts',
      evidence_start_line: 2,
      evidence_end_line: 2,
    });
    // package.json (config probe) + users.ts = 2 sampled files, 1 dropped.
    expect(body.stats).toMatchObject({ sampledFileCount: 2, droppedCount: 1 });

    const list = await app.inject({ method: 'GET', url: `/repos/${repoId}/conventions` });
    expect(list.json().conventions).toHaveLength(1);
    expect(list.json().stats.droppedCount).toBe(1);
    await app.close();
  });

  it('accept keeps the status↔accepted dual-write; rule edit persists; bulk deselect resets', async () => {
    const app = await makeApp();
    const list = (await app.inject({ method: 'GET', url: `/repos/${repoId}/conventions` })).json();
    const id = list.conventions[0].id as string;

    const accepted = await app.inject({
      method: 'PATCH',
      url: `/conventions/${id}`,
      payload: { status: 'accepted', rule: 'Always prefer async/await' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ status: 'accepted', rule: 'Always prefer async/await' });

    const [row] = await pg.handle.db
      .select()
      .from(t.conventions)
      .where(eq(t.conventions.id, id));
    expect(row).toMatchObject({ status: 'accepted', accepted: true });

    const bulk = await app.inject({
      method: 'PATCH',
      url: `/repos/${repoId}/conventions`,
      payload: { status: 'pending' },
    });
    expect(bulk.json()).toEqual({ updated: 1 });
    const [after] = await pg.handle.db
      .select()
      .from(t.conventions)
      .where(eq(t.conventions.id, id));
    expect(after).toMatchObject({ status: 'pending', accepted: false });
    await app.close();
  });

  it('re-scan replaces the previous candidates (fresh ids), scan row is upserted not duplicated', async () => {
    const app = await makeApp();
    const before = (await app.inject({ method: 'GET', url: `/repos/${repoId}/conventions` })).json();
    const oldId = before.conventions[0].id as string;

    const res = await app.inject({ method: 'POST', url: `/repos/${repoId}/conventions/extract` });
    expect(res.statusCode).toBe(200);
    expect(res.json().conventions[0].id).not.toBe(oldId);

    const scans = await pg.handle.db
      .select()
      .from(t.conventionsScans)
      .where(eq(t.conventionsScans.repoId, repoId));
    expect(scans).toHaveLength(1);
    await app.close();
  });

  it('404 for a repo id outside the workspace; 422 for a non-uuid id', async () => {
    const app = await makeApp();
    const missing = await app.inject({
      method: 'POST',
      url: '/repos/00000000-0000-0000-0000-000000000000/conventions/extract',
    });
    expect(missing.statusCode).toBe(404);
    const invalid = await app.inject({ method: 'GET', url: '/repos/not-a-uuid/conventions' });
    expect(invalid.statusCode).toBe(422);
    await app.close();
  });

  it('POST /skills accepts evidence_files and returns them on the DTO', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/skills',
      payload: {
        name: 'payments-api-conventions',
        description: 'House conventions extracted from payments-api',
        type: 'convention',
        body: '# payments-api-conventions\n\nRules…',
        source: 'extracted',
        evidence_files: ['src/api/users.ts'],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      source: 'extracted',
      evidence_files: ['src/api/users.ts'],
    });
    await app.close();
  });

  it('deleting the repo cascades conventions and the scan row', async () => {
    await pg.handle.db
      .delete(t.repos)
      .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.id, repoId)));
    const rows = await pg.handle.db
      .select()
      .from(t.conventions)
      .where(eq(t.conventions.repoId, repoId));
    const scans = await pg.handle.db
      .select()
      .from(t.conventionsScans)
      .where(eq(t.conventionsScans.repoId, repoId));
    expect(rows).toHaveLength(0);
    expect(scans).toHaveLength(0);
  });
});
