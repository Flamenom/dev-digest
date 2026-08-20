import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';
import { SkillsRepository } from '../src/modules/skills/repository.js';
import { splitEnabledSkills } from '../src/modules/_shared/skill-prompt.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  console.warn('[skills] Docker not available — skipping integration tests.');
}

/**
 * L02 skills module against a real Postgres: CRUD roundtrip with body
 * versioning, the /skills/usage join, run-time resolveAgentSkills ordering
 * (+ the run-side enabled filter), the multipart import preview route, and
 * the seeded Test Quality Reviewer wiring.
 */
d('skills module (integration)', () => {
  let pg: PgFixture;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    await seed(pg.handle.db); // idempotency: a second run must not duplicate anything
  });
  afterAll(async () => {
    await pg?.stop();
  });

  function makeApp() {
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    return buildApp({
      config,
      db: pg.handle.db,
      overrides: { git: new MockGitClient(), github: new MockGitHubClient() },
    });
  }

  const createBody = {
    name: 'crud-roundtrip-skill',
    description: 'Directive description.',
    type: 'rubric' as const,
    body: '# Rule\n\nCheck the thing.',
  };

  it('CRUD roundtrip: create → list (newest first) → get → update → delete', async () => {
    const app = await makeApp();

    const created = await app.inject({ method: 'POST', url: '/skills', payload: createBody });
    expect(created.statusCode).toBe(201);
    const skill = created.json();
    expect(skill).toMatchObject({
      ...createBody,
      source: 'manual', // default
      enabled: true,
      version: 1,
    });

    const list = (await app.inject({ method: 'GET', url: '/skills' })).json();
    expect(list[0].id).toBe(skill.id); // newest first (seeded skills are older)
    expect(list.map((s: { name: string }) => s.name)).toContain('branch-coverage-rubric');

    const got = await app.inject({ method: 'GET', url: `/skills/${skill.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().name).toBe(createBody.name);

    // Body edit bumps version + snapshots with the note.
    const updated = await app.inject({
      method: 'PUT',
      url: `/skills/${skill.id}`,
      payload: { body: '# Rule v2\n\nCheck harder.', note: 'Sharper wording' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().version).toBe(2);

    // Enabled/name-only changes do NOT bump.
    const toggled = await app.inject({
      method: 'PUT',
      url: `/skills/${skill.id}`,
      payload: { enabled: false, name: 'crud-roundtrip-skill-renamed' },
    });
    expect(toggled.json().version).toBe(2);

    // Version history: newest first, bodies + notes included.
    const versions = (
      await app.inject({ method: 'GET', url: `/skills/${skill.id}/versions` })
    ).json();
    expect(versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(versions[0]).toMatchObject({ note: 'Sharper wording', body: '# Rule v2\n\nCheck harder.' });
    expect(versions[1]).toMatchObject({ note: 'Initial version', body: createBody.body });

    const v1 = await app.inject({ method: 'GET', url: `/skills/${skill.id}/versions/1` });
    expect(v1.statusCode).toBe(200);
    expect(v1.json().body).toBe(createBody.body);
    expect(
      (await app.inject({ method: 'GET', url: `/skills/${skill.id}/versions/99` })).statusCode,
    ).toBe(404);

    const del = await app.inject({ method: 'DELETE', url: `/skills/${skill.id}` });
    expect(del.json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'GET', url: `/skills/${skill.id}` })).statusCode).toBe(404);
    await app.close();
  });

  it('GET /skills/usage joins agent_skills ⋈ agents (and is not shadowed by /skills/:id)', async () => {
    const app = await makeApp();

    const skillId = (
      await app.inject({
        method: 'POST',
        url: '/skills',
        payload: { ...createBody, name: 'usage-skill' },
      })
    ).json().id as string;

    const agents = (await app.inject({ method: 'GET', url: '/agents' })).json();
    const general = agents.find((a: { name: string }) => a.name === 'General Reviewer');

    // Link via the EXISTING agent-side endpoint.
    const link = await app.inject({
      method: 'POST',
      url: `/agents/${general.id}/skills`,
      payload: { skill_id: skillId },
    });
    expect(link.statusCode).toBe(200);

    const usage = (await app.inject({ method: 'GET', url: '/skills/usage' })).json();
    const entry = usage.find((u: { skill_id: string }) => u.skill_id === skillId);
    expect(entry.agents).toEqual([{ id: general.id, name: 'General Reviewer' }]);

    // Seeded skills report the Test Quality Reviewer.
    const seededSkill = (await app.inject({ method: 'GET', url: '/skills' }))
      .json()
      .find((s: { name: string }) => s.name === 'branch-coverage-rubric');
    const seededUsage = usage.find(
      (u: { skill_id: string }) => u.skill_id === seededSkill.id,
    );
    expect(seededUsage.agents.map((a: { name: string }) => a.name)).toContain(
      'Test Quality Reviewer',
    );
    await app.close();
  });

  it('resolveAgentSkills returns linked skills ordered; the run-side filter drops disabled', async () => {
    const app = await makeApp();
    const repo = new SkillsRepository(pg.handle.db);

    const mk = async (name: string, enabled: boolean) =>
      (
        await app.inject({
          method: 'POST',
          url: '/skills',
          payload: { ...createBody, name, enabled },
        })
      ).json().id as string;
    const first = await mk('resolve-b-first', true);
    const second = await mk('resolve-a-second', false); // globally disabled
    const third = await mk('resolve-c-third', true);

    const agents = (await app.inject({ method: 'GET', url: '/agents' })).json();
    const perf = agents.find((a: { name: string }) => a.name === 'Performance Reviewer');
    await app.inject({
      method: 'POST',
      url: `/agents/${perf.id}/skills`,
      payload: { skill_ids: [first, second, third] },
    });

    const resolved = await repo.resolveAgentSkills(perf.id);
    expect(resolved.map((s) => s.name)).toEqual([
      'resolve-b-first',
      'resolve-a-second',
      'resolve-c-third',
    ]);

    // Run-side split (what run-executor injects vs logs as skipped).
    const { injected, skipped } = splitEnabledSkills(resolved);
    expect(skipped).toBe(1);
    expect(injected).toHaveLength(2);
    expect(injected[0]!.startsWith('### resolve-b-first\n')).toBe(true);
    expect(injected.join('\n')).not.toContain('resolve-a-second');
    await app.close();
  });

  it('POST /skills/import returns a parse-only preview and persists nothing', async () => {
    const app = await makeApp();
    const zip = readFileSync(
      path.resolve(__dirname, 'fixtures/skill-import/flaky-test-patterns.zip'),
    );
    const boundary = '----devdigestimporttest';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="flaky-test-patterns.zip"\r\nContent-Type: application/zip\r\n\r\n`,
      ),
      zip,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const before = (await app.inject({ method: 'GET', url: '/skills' })).json().length;
    const res = await app.inject({
      method: 'POST',
      url: '/skills/import',
      payload,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(res.statusCode).toBe(200);
    const preview = res.json();
    expect(preview.name).toBe('flaky-test-patterns');
    expect(preview.skipped).toEqual(['install.sh']);
    expect(preview.body).toContain('Real-clock sleeps');

    // Parse-only: nothing was persisted.
    const after = (await app.inject({ method: 'GET', url: '/skills' })).json().length;
    expect(after).toBe(before);
    await app.close();
  });

  it('seed created 3 skills + Test Quality Reviewer linked in order 0,1,2 (idempotently)', async () => {
    const { db } = pg.handle;
    const [agent] = await db
      .select()
      .from(t.agents)
      .where(eq(t.agents.name, 'Test Quality Reviewer'));
    expect(agent).toBeDefined();
    expect(agent!.ciFailOn).toBe('warning');

    const links = await db
      .select({ order: t.agentSkills.order, name: t.skills.name, note: t.skillVersions.note })
      .from(t.agentSkills)
      .innerJoin(t.skills, eq(t.agentSkills.skillId, t.skills.id))
      .innerJoin(
        t.skillVersions,
        and(eq(t.skillVersions.skillId, t.skills.id), eq(t.skillVersions.version, 1)),
      )
      .where(eq(t.agentSkills.agentId, agent!.id))
      .orderBy(t.agentSkills.order);
    expect(links).toEqual([
      { order: 0, name: 'branch-coverage-rubric', note: 'Initial version' },
      { order: 1, name: 'corner-case-checklist', note: 'Initial version' },
      { order: 2, name: 'mock-overuse-gate', note: 'Initial version' },
    ]);
  });

  it('POST /skills/:id/restore re-applies a snapshot as a new head; GET stats reflects it', async () => {
    const app = await makeApp();

    const created = await app.inject({
      method: 'POST',
      url: '/skills',
      payload: {
        name: 'restore-roundtrip-skill',
        description: 'Directive description.',
        type: 'convention',
        body: 'v1 body',
      },
    });
    const skill = created.json();

    await app.inject({
      method: 'PUT',
      url: `/skills/${skill.id}`,
      payload: { body: 'v2 body', note: 'Second pass' },
    });

    const restored = await app.inject({
      method: 'POST',
      url: `/skills/${skill.id}/restore`,
      payload: { version: 1 },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ body: 'v1 body', version: 3 });

    // History is untouched: v1..v3, newest first, with the restore note.
    const versions = (
      await app.inject({ method: 'GET', url: `/skills/${skill.id}/versions` })
    ).json();
    expect(versions.map((v: { version: number; note: string | null }) => [v.version, v.note])).toEqual([
      [3, 'Restored from v1'],
      [2, 'Second pass'],
      [1, 'Initial version'],
    ]);

    // Unknown snapshot -> 404, nothing bumped.
    const missing = await app.inject({
      method: 'POST',
      url: `/skills/${skill.id}/restore`,
      payload: { version: 99 },
    });
    expect(missing.statusCode).toBe(404);

    const stats = (await app.inject({ method: 'GET', url: `/skills/${skill.id}/stats` })).json();
    expect(stats).toMatchObject({
      skill_id: skill.id,
      used_by_agents: 0,
      agents: [],
      version_count: 3,
      latest_version: 3,
    });
    expect(stats.last_updated_at).toBeTruthy();
  });

  it('GET /skills/:id/stats lists the linking agents; GET /agents carries skill_count', async () => {
    const app = await makeApp();
    const { db } = pg.handle;
    const [seededSkill] = await db
      .select()
      .from(t.skills)
      .where(eq(t.skills.name, 'branch-coverage-rubric'));

    const stats = (
      await app.inject({ method: 'GET', url: `/skills/${seededSkill!.id}/stats` })
    ).json();
    expect(stats.used_by_agents).toBe(1);
    expect(stats.agents.map((a: { name: string }) => a.name)).toEqual(['Test Quality Reviewer']);

    const agents = (await app.inject({ method: 'GET', url: '/agents' })).json();
    const byName = new Map(
      agents.map((a: { name: string; skill_count: number }) => [a.name, a.skill_count]),
    );
    expect(byName.get('Test Quality Reviewer')).toBe(3);
    expect(byName.get('API Contract Reviewer')).toBe(4);
    // General Reviewer got one link from the /skills/usage test above (shared fixture).
    expect(byName.get('Security Reviewer')).toBe(0);
  });

  it('seed created the API Contract Reviewer linked to its 4 skills in order 0-3 (idempotently)', async () => {
    const { db } = pg.handle;
    const [agent] = await db
      .select()
      .from(t.agents)
      .where(eq(t.agents.name, 'API Contract Reviewer'));
    expect(agent).toBeDefined();
    expect(agent!.ciFailOn).toBe('critical');

    const links = await db
      .select({ order: t.agentSkills.order, name: t.skills.name })
      .from(t.agentSkills)
      .innerJoin(t.skills, eq(t.agentSkills.skillId, t.skills.id))
      .where(eq(t.agentSkills.agentId, agent!.id))
      .orderBy(t.agentSkills.order);
    expect(links).toEqual([
      { order: 0, name: 'breaking-change' },
      { order: 1, name: 'response-schema' },
      { order: 2, name: 'semver-discipline' },
      { order: 3, name: 'deprecation-policy' },
    ]);
  });
});
