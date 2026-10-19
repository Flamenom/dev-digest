import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { asSession, buildGoogleApp, type GoogleTestApp, type TestUser } from './helpers/google-mode.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { bootstrap } from '../src/db/bootstrap.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';
import { SkillsRepository } from '../src/modules/skills/repository.js';
import type { SessionCredential } from './helpers/google-mode.js';

/**
 * T27 — skills attribution (AC-47 skills half, AC-48 legacy rows).
 * Every skill write records the acting user as creator / last updater, and
 * every version-producing write records the version author. DTOs expose
 * `created_by` / `updated_by` / version `author` as ActorRefs; rows written
 * before multi-user (no actor) render null. Local mode attributes the seeded
 * system user (`is_system: true`).
 */
const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;
if (!hasDocker) console.warn('[skills-attribution] Docker not available — skipping.');

interface Ref {
  user_id: string;
  name: string;
  is_system?: boolean;
}

d('skills attribution (google mode)', () => {
  let pg: PgFixture;
  let g: GoogleTestApp;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let aliceS: SessionCredential;
  let bobS: SessionCredential;
  let carolS: SessionCredential;

  beforeAll(async () => {
    pg = await startPg();
    g = await buildGoogleApp({ pg });
    alice = await g.createUser({ name: 'Alice Admin', role: 'admin' });
    bob = await g.createUser({ name: 'Bob Admin', role: 'admin' });
    carol = await g.createUser({ name: 'Carol Member', role: 'member' });
    aliceS = await g.signIn(alice);
    bobS = await g.signIn(bob);
    carolS = await g.signIn(carol);
  }, 120_000);
  afterAll(async () => {
    await g?.close();
    await pg?.stop();
  });

  const ref = (u: TestUser): Ref => ({ user_id: u.userId, name: u.name });

  async function versionRows(skillId: string) {
    return pg.handle.db
      .select({ version: t.skillVersions.version, authorId: t.skillVersions.authorId })
      .from(t.skillVersions)
      .where(eq(t.skillVersions.skillId, skillId))
      .orderBy(t.skillVersions.version);
  }

  it('create → update → restore → docs: creator, updater and version authors recorded', async () => {
    const created = await g.app.inject(
      asSession(aliceS, {
        method: 'POST',
        url: '/skills',
        payload: { name: 'attr-skill', description: 'd', type: 'rubric', body: 'v1 body' },
      }),
    );
    expect(created.statusCode).toBe(201);
    const skill = created.json();
    expect(skill.created_by).toMatchObject(ref(alice));
    expect(skill.updated_by).toMatchObject(ref(alice));
    // Raw ids never leak onto the wire.
    expect(skill).not.toHaveProperty('createdById');
    expect(skill).not.toHaveProperty('updatedById');

    // Bob edits the body → new version authored by Bob; creator stays Alice.
    const updated = await g.app.inject(
      asSession(bobS, {
        method: 'PUT',
        url: `/skills/${skill.id}`,
        payload: { body: 'v2 body', note: 'tighten' },
      }),
    );
    expect(updated.statusCode).toBe(200);
    expect(updated.json().version).toBe(2);
    expect(updated.json().created_by).toMatchObject(ref(alice));
    expect(updated.json().updated_by).toMatchObject(ref(bob));

    // Bob restores v1 → v3 authored by Bob.
    const restored = await g.app.inject(
      asSession(bobS, {
        method: 'POST',
        url: `/skills/${skill.id}/restore`,
        payload: { version: 1 },
      }),
    );
    expect(restored.statusCode).toBe(200);
    expect(restored.json().version).toBe(3);

    // Alice attaches docs → updated_by Alice, no new version.
    const docs = await g.app.inject(
      asSession(aliceS, {
        method: 'PUT',
        url: `/skills/${skill.id}/attached-docs`,
        payload: { paths: ['docs/a.md'] },
      }),
    );
    expect(docs.statusCode).toBe(200);
    expect(docs.json().version).toBe(3);
    expect(docs.json().updated_by).toMatchObject(ref(alice));

    // DB truth.
    const [row] = await pg.handle.db.select().from(t.skills).where(eq(t.skills.id, skill.id));
    expect(row!.createdBy).toBe(alice.userId);
    expect(row!.updatedBy).toBe(alice.userId);
    expect(await versionRows(skill.id)).toEqual([
      { version: 1, authorId: alice.userId },
      { version: 2, authorId: bob.userId },
      { version: 3, authorId: bob.userId },
    ]);

    // Version DTOs expose the author (Members can read).
    const versions = await g.app.inject(
      asSession(carolS, { method: 'GET', url: `/skills/${skill.id}/versions` }),
    );
    expect(versions.statusCode).toBe(200);
    const byVersion = new Map(
      (versions.json() as Array<{ version: number; author: Ref | null }>).map((v) => [v.version, v]),
    );
    expect(byVersion.get(1)!.author).toMatchObject(ref(alice));
    expect(byVersion.get(2)!.author).toMatchObject(ref(bob));
    expect(byVersion.get(3)!.author).toMatchObject(ref(bob));
    expect(byVersion.get(2)).not.toHaveProperty('authorId');

    const one = await g.app.inject(
      asSession(carolS, { method: 'GET', url: `/skills/${skill.id}/versions/2` }),
    );
    expect(one.json().author).toMatchObject(ref(bob));

    // GET one + list carry the refs too.
    const got = await g.app.inject(asSession(carolS, { method: 'GET', url: `/skills/${skill.id}` }));
    expect(got.json().created_by).toMatchObject(ref(alice));
    const list = await g.app.inject(asSession(carolS, { method: 'GET', url: '/skills' }));
    const listed = (list.json() as Array<{ id: string; updated_by: Ref | null }>).find(
      (s) => s.id === skill.id,
    );
    expect(listed!.updated_by).toMatchObject(ref(alice));
  });

  it('a non-body edit records the updater without producing a version', async () => {
    const created = await g.app.inject(
      asSession(aliceS, {
        method: 'POST',
        url: '/skills',
        payload: { name: 'toggle-skill', description: 'd', type: 'custom', body: 'b' },
      }),
    );
    const id = created.json().id as string;
    const toggled = await g.app.inject(
      asSession(bobS, { method: 'PUT', url: `/skills/${id}`, payload: { enabled: false } }),
    );
    expect(toggled.json().version).toBe(1);
    expect(toggled.json().updated_by).toMatchObject(ref(bob));
    expect(await versionRows(id)).toEqual([{ version: 1, authorId: alice.userId }]);
  });

  it('Members cannot write skills (route policy) and nothing is attributed to them', async () => {
    const res = await g.app.inject(
      asSession(carolS, {
        method: 'POST',
        url: '/skills',
        payload: { name: 'member-skill', description: 'd', type: 'custom', body: 'b' },
      }),
    );
    expect(res.statusCode).toBe(403);
    const rows = await pg.handle.db
      .select({ id: t.skills.id })
      .from(t.skills)
      .where(eq(t.skills.createdBy, carol.userId));
    expect(rows).toEqual([]);
  });

  it('AC-48: legacy skills (no actor) render null refs, versions null author', async () => {
    const legacy = await new SkillsRepository(pg.handle.db).insert({
      workspaceId: g.workspaceId,
      name: 'legacy-skill',
      description: 'd',
      type: 'rubric',
      body: 'old',
    });
    const got = await g.app.inject(asSession(carolS, { method: 'GET', url: `/skills/${legacy.id}` }));
    expect(got.statusCode).toBe(200);
    expect(got.json().created_by).toBeNull();
    expect(got.json().updated_by).toBeNull();
    const versions = await g.app.inject(
      asSession(carolS, { method: 'GET', url: `/skills/${legacy.id}/versions` }),
    );
    expect(versions.json()[0].author).toBeNull();
    const [v1] = await pg.handle.db
      .select()
      .from(t.skillVersions)
      .where(and(eq(t.skillVersions.skillId, legacy.id), eq(t.skillVersions.version, 1)));
    expect(v1!.authorId).toBeNull();
  });
});

d('skills attribution (local mode)', () => {
  let pg: PgFixture;

  beforeAll(async () => {
    pg = await startPg();
    await bootstrap(pg.handle.db); // default workspace + system user
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });

  it('local writes are attributed to the seeded system user (is_system)', async () => {
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      AUTH_MODE: 'local',
      DATABASE_URL: pg.url,
    } as NodeJS.ProcessEnv);
    const app = await buildApp({
      config,
      db: pg.handle.db,
      overrides: { git: new MockGitClient(), github: new MockGitHubClient() },
    });
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/skills',
        payload: { name: 'local-skill', description: 'd', type: 'rubric', body: 'b1' },
      });
      expect(created.statusCode).toBe(201);
      const skill = created.json();
      expect(skill.created_by).toMatchObject({ is_system: true });
      expect(skill.updated_by?.user_id).toBe(skill.created_by.user_id);

      const updated = await app.inject({
        method: 'PUT',
        url: `/skills/${skill.id}`,
        payload: { body: 'b2' },
      });
      expect(updated.statusCode).toBe(200);
      const versions = await app.inject({ method: 'GET', url: `/skills/${skill.id}/versions` });
      for (const v of versions.json() as Array<{ author: Ref | null }>) {
        expect(v.author).toMatchObject({ user_id: skill.created_by.user_id, is_system: true });
      }
    } finally {
      await app.close();
    }
  });
});
