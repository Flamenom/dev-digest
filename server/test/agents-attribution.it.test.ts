import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { asSession, buildGoogleApp, type GoogleTestApp } from './helpers/google-mode.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { bootstrap } from '../src/db/bootstrap.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  console.warn('[agents-attribution] Docker not available — skipping integration tests.');
}

/**
 * T26 / AC-47 — agents record the acting user: `created_by` + `updated_by` on the
 * agent, `author_id` on every version-producing write; DTOs expose them as
 * ActorRefs. Legacy rows (no actor) → null (AC-48). Local mode → the seeded
 * system user (AC-49). Agent writes are Admin-only via the route policy.
 */
const createBody = {
  name: 'Attributed Agent',
  provider: 'openai' as const,
  model: 'gpt-4o-mini',
  system_prompt: 'Review the diff.',
};

d('agents attribution (google mode)', () => {
  let pg: PgFixture;
  let g: GoogleTestApp;

  beforeAll(async () => {
    pg = await startPg();
    g = await buildGoogleApp({ pg });
  });
  afterAll(async () => {
    await g?.close();
    await pg?.stop();
  });

  it('create → created_by/updated_by/v1 author = creator; Admin edit → updated_by + new version author = editor', async () => {
    const alice = await g.createUser({ name: 'Alice Admin', role: 'admin' });
    const bob = await g.createUser({ name: 'Bob Admin', role: 'admin' });
    const sa = await g.signIn(alice);
    const sb = await g.signIn(bob);

    const created = await g.app.inject(
      asSession(sa, { method: 'POST', url: '/agents', payload: createBody }),
    );
    expect(created.statusCode).toBe(201);
    const agent = created.json();
    expect(agent.created_by).toEqual({ user_id: alice.userId, name: 'Alice Admin' });
    expect(agent.updated_by).toEqual({ user_id: alice.userId, name: 'Alice Admin' });
    expect(agent).not.toHaveProperty('created_by_id');
    expect(agent).not.toHaveProperty('updated_by_id');

    const edited = await g.app.inject(
      asSession(sb, {
        method: 'PUT',
        url: `/agents/${agent.id}`,
        payload: { system_prompt: 'Review the diff carefully.' },
      }),
    );
    expect(edited.statusCode).toBe(200);
    expect(edited.json().version).toBe(2);
    expect(edited.json().created_by).toEqual({ user_id: alice.userId, name: 'Alice Admin' });
    expect(edited.json().updated_by).toEqual({ user_id: bob.userId, name: 'Bob Admin' });

    const versions = await g.app.inject(
      asSession(sa, { method: 'GET', url: `/agents/${agent.id}/versions` }),
    );
    expect(versions.statusCode).toBe(200);
    const list = versions.json() as Array<{ version: number; author: unknown }>;
    expect(list.map((v) => [v.version, v.author])).toEqual([
      [2, { user_id: bob.userId, name: 'Bob Admin' }],
      [1, { user_id: alice.userId, name: 'Alice Admin' }],
    ]);
    expect(list[0]).not.toHaveProperty('author_id');

    const one = await g.app.inject(
      asSession(sa, { method: 'GET', url: `/agents/${agent.id}/versions/2` }),
    );
    expect(one.json().author).toEqual({ user_id: bob.userId, name: 'Bob Admin' });

    // Promote v1 (by Alice) → v3 authored by Alice; agent updated_by = Alice.
    const promoted = await g.app.inject(
      asSession(sa, { method: 'POST', url: `/agents/${agent.id}/versions/1/promote` }),
    );
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().new_version).toBe(3);
    expect(promoted.json().agent.updated_by).toEqual({ user_id: alice.userId, name: 'Alice Admin' });
    const [v3] = await g.db
      .select()
      .from(t.agentVersions)
      .where(eq(t.agentVersions.agentId, agent.id))
      .orderBy(t.agentVersions.version)
      .then((rows) => rows.filter((r) => r.version === 3));
    expect(v3?.authorId).toBe(alice.userId);

    // Non-versioning writes (attached docs, skills) still record the updater.
    const docs = await g.app.inject(
      asSession(sb, {
        method: 'PUT',
        url: `/agents/${agent.id}/attached-docs`,
        payload: { paths: ['docs/spec.md'] },
      }),
    );
    expect(docs.statusCode).toBe(200);
    expect(docs.json().updated_by).toEqual({ user_id: bob.userId, name: 'Bob Admin' });
    expect(docs.json().version).toBe(3);

    const skills = await g.app.inject(
      asSession(sa, {
        method: 'POST',
        url: `/agents/${agent.id}/skills`,
        payload: { skill_ids: [] },
      }),
    );
    expect(skills.statusCode).toBe(200);
    const [row] = await g.db.select().from(t.agents).where(eq(t.agents.id, agent.id));
    expect(row?.updatedBy).toBe(alice.userId);
    expect(row?.createdBy).toBe(alice.userId);

    const listRes = await g.app.inject(asSession(sb, { method: 'GET', url: '/agents' }));
    const mine = (listRes.json() as Array<{ id: string; created_by: unknown; updated_by: unknown }>).find(
      (a) => a.id === agent.id,
    );
    expect(mine?.created_by).toEqual({ user_id: alice.userId, name: 'Alice Admin' });
    expect(mine?.updated_by).toEqual({ user_id: alice.userId, name: 'Alice Admin' });
  });

  it('legacy agent (no recorded actors) → created_by/updated_by/author are null', async () => {
    const admin = await g.createUser({ role: 'admin' });
    const s = await g.signIn(admin);
    const [legacy] = await g.db
      .insert(t.agents)
      .values({
        workspaceId: g.workspaceId,
        name: 'Legacy',
        description: '',
        provider: 'openai',
        model: 'gpt-4o-mini',
        systemPrompt: 'x',
        version: 1,
      })
      .returning();
    await g.db.insert(t.agentVersions).values({
      agentId: legacy!.id,
      version: 1,
      configJson: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        system_prompt: 'x',
        output_schema: null,
        strategy: legacy!.strategy,
        ci_fail_on: legacy!.ciFailOn,
        repo_intel: legacy!.repoIntel,
        skills: [],
      },
    });

    const res = await g.app.inject(asSession(s, { method: 'GET', url: `/agents/${legacy!.id}` }));
    expect(res.statusCode).toBe(200);
    expect(res.json().created_by).toBeNull();
    expect(res.json().updated_by).toBeNull();

    const versions = await g.app.inject(
      asSession(s, { method: 'GET', url: `/agents/${legacy!.id}/versions` }),
    );
    expect(versions.json()[0].author).toBeNull();
  });

  it('a Member cannot create or edit agents (route policy) and nothing is attributed', async () => {
    const member = await g.createUser({ role: 'member' });
    const s = await g.signIn(member);
    const res = await g.app.inject(
      asSession(s, { method: 'POST', url: '/agents', payload: { ...createBody, name: 'Nope' } }),
    );
    expect(res.statusCode).toBe(403);
    const rows = await g.db.select().from(t.agents).where(eq(t.agents.name, 'Nope'));
    expect(rows).toHaveLength(0);
  });
});

d('agents attribution (local mode)', () => {
  let pg: PgFixture;

  beforeAll(async () => {
    pg = await startPg();
  });
  afterAll(async () => {
    await pg?.stop();
  });

  it('every recorded actor is the seeded system user (AC-49)', async () => {
    const boot = await bootstrap(pg.handle.db);
    const config = loadConfig({ ...process.env, NODE_ENV: 'test', AUTH_MODE: 'local' } as NodeJS.ProcessEnv);
    const app = await buildApp({
      config,
      db: pg.handle.db,
      overrides: { git: new MockGitClient(), github: new MockGitHubClient() },
    });
    try {
      const created = await app.inject({ method: 'POST', url: '/agents', payload: createBody });
      expect(created.statusCode).toBe(201);
      const agent = created.json();
      expect(agent.created_by).toMatchObject({ user_id: boot.userId, is_system: true });
      expect(agent.updated_by).toMatchObject({ user_id: boot.userId, is_system: true });

      await app.inject({
        method: 'PUT',
        url: `/agents/${agent.id}`,
        payload: { model: 'gpt-4o' },
      });
      const versions = (
        await app.inject({ method: 'GET', url: `/agents/${agent.id}/versions` })
      ).json() as Array<{ author: { user_id: string } | null }>;
      expect(versions).toHaveLength(2);
      for (const v of versions) expect(v.author?.user_id).toBe(boot.userId);
    } finally {
      await app.close();
    }
  });
});
