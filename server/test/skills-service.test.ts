import { describe, it, expect, vi } from 'vitest';
import { SkillsService } from '../src/modules/skills/service.js';
import type { SkillRow, SkillsRepository } from '../src/modules/skills/repository.js';
import type { Container } from '../src/platform/container.js';

/**
 * Hermetic tests for the skills versioning rule (spec §3.6): a BODY edit bumps
 * the version and snapshots skill_versions with the note; enabled/name-only
 * changes don't bump; a restore-style PUT (posting an OLD body) creates a NEW
 * head version. The repository is faked (no DB) — the decision under test
 * lives in the service (helpers' isBodyChange).
 */

function skillRow(overrides: Partial<SkillRow> = {}): SkillRow {
  return {
    id: 'skill-1',
    workspaceId: 'ws-1',
    name: 'branch-coverage-rubric',
    description: 'Judge tests by branches.',
    type: 'rubric',
    source: 'manual',
    body: 'v1 body',
    enabled: true,
    version: 1,
    evidenceFiles: null,
    createdAt: new Date('2026-08-18T00:00:00Z'),
    ...overrides,
  } as SkillRow;
}

function makeFakeRepo(existing: SkillRow) {
  const repo = {
    getById: vi.fn(async () => existing),
    // Echo the patch back like the real update does (returning()).
    update: vi.fn(
      async (
        _ws: string,
        _id: string,
        patch: Record<string, unknown>,
        bump?: { nextVersion: number; note: string | null },
      ) => ({ ...existing, ...patch, version: bump ? bump.nextVersion : existing.version }),
    ),
    insert: vi.fn(async (values: Record<string, unknown>) =>
      skillRow({ ...values, id: 'new-skill', version: 1 } as Partial<SkillRow>),
    ),
    getVersion: vi.fn(async (_id: string, version: number) => ({
      skillId: existing.id,
      version,
      body: `v${version} body`,
      note: null,
      createdAt: new Date('2026-08-18T00:00:00Z'),
    })),
    listVersions: vi.fn(async () => [
      { skillId: existing.id, version: existing.version, body: existing.body, note: null, createdAt: new Date('2026-08-19T00:00:00Z') },
    ]),
    agentsUsing: vi.fn(async () => [{ id: 'agent-1', name: 'API Contract Reviewer' }]),
  };
  return repo;
}

function makeService(repo: ReturnType<typeof makeFakeRepo>) {
  return new SkillsService({} as Container, repo as unknown as SkillsRepository);
}

describe('SkillsService versioning', () => {
  it('a body edit bumps the version and snapshots with the note', async () => {
    const repo = makeFakeRepo(skillRow({ version: 1, body: 'v1 body' }));
    const service = makeService(repo);

    const updated = await service.update('ws-1', 'skill-1', {
      body: 'v2 body',
      note: 'Tightened the rubric',
    });

    expect(updated?.version).toBe(2);
    expect(repo.update).toHaveBeenCalledWith(
      'ws-1',
      'skill-1',
      { body: 'v2 body' }, // note is NOT a column patch
      { nextVersion: 2, note: 'Tightened the rubric' },
    );
  });

  it('a body edit without a note snapshots with note: null', async () => {
    const repo = makeFakeRepo(skillRow());
    const service = makeService(repo);
    await service.update('ws-1', 'skill-1', { body: 'v2 body' });
    expect(repo.update).toHaveBeenCalledWith('ws-1', 'skill-1', { body: 'v2 body' }, {
      nextVersion: 2,
      note: null,
    });
  });

  it('an enabled-only toggle does NOT bump the version', async () => {
    const repo = makeFakeRepo(skillRow({ version: 3 }));
    const service = makeService(repo);
    const updated = await service.update('ws-1', 'skill-1', { enabled: false });
    expect(updated?.version).toBe(3);
    expect(repo.update).toHaveBeenCalledWith('ws-1', 'skill-1', { enabled: false }, undefined);
  });

  it('name/description/type-only changes do NOT bump the version', async () => {
    const repo = makeFakeRepo(skillRow({ version: 2 }));
    const service = makeService(repo);
    const updated = await service.update('ws-1', 'skill-1', {
      name: 'renamed',
      description: 'new desc',
      type: 'convention',
    });
    expect(updated?.version).toBe(2);
    const [, , , bump] = repo.update.mock.calls[0]!;
    expect(bump).toBeUndefined();
  });

  it('re-sending the SAME body does not bump', async () => {
    const repo = makeFakeRepo(skillRow({ body: 'same body', version: 4 }));
    const service = makeService(repo);
    const updated = await service.update('ws-1', 'skill-1', { body: 'same body', note: 'noop' });
    expect(updated?.version).toBe(4);
    expect(repo.update.mock.calls[0]![3]).toBeUndefined();
  });

  it('restore-style PUT (an OLD body) creates a NEW head version', async () => {
    // Head is v3; the user restores the v1 body via a normal PUT.
    const repo = makeFakeRepo(skillRow({ body: 'v3 body', version: 3 }));
    const service = makeService(repo);

    const updated = await service.update('ws-1', 'skill-1', {
      body: 'v1 body',
      note: 'Restored from v1',
    });

    expect(updated?.version).toBe(4); // new head, history untouched
    expect(repo.update).toHaveBeenCalledWith(
      'ws-1',
      'skill-1',
      { body: 'v1 body' },
      { nextVersion: 4, note: 'Restored from v1' },
    );
  });

  it('update on an unknown skill returns undefined (route → 404)', async () => {
    const repo = makeFakeRepo(skillRow());
    repo.getById.mockResolvedValueOnce(undefined as unknown as SkillRow);
    const service = makeService(repo);
    expect(await service.update('ws-1', 'ghost', { body: 'x' })).toBeUndefined();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('create defaults source to manual and passes enabled through', async () => {
    const repo = makeFakeRepo(skillRow());
    const service = makeService(repo);
    await service.create('ws-1', {
      name: 'imported',
      description: 'd',
      type: 'custom',
      body: 'b',
      enabled: false,
    });
    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'manual', enabled: false, workspaceId: 'ws-1' }),
    );
  });
});

describe('SkillsService restore (POST /skills/:id/restore)', () => {
  it('re-applies the snapshot body as a NEW head version with a "Restored from vN" note', async () => {
    const repo = makeFakeRepo(skillRow({ body: 'v3 body', version: 3 }));
    const service = makeService(repo);

    const restored = await service.restore('ws-1', 'skill-1', 1);

    expect(restored?.version).toBe(4); // new head, history untouched
    expect(repo.getVersion).toHaveBeenCalledWith('skill-1', 1);
    expect(repo.update).toHaveBeenCalledWith(
      'ws-1',
      'skill-1',
      { body: 'v1 body' },
      { nextVersion: 4, note: 'Restored from v1' },
    );
  });

  it('restoring a snapshot identical to the current body is a no-op (no bump)', async () => {
    const repo = makeFakeRepo(skillRow({ body: 'v2 body', version: 2 }));
    const service = makeService(repo);
    const restored = await service.restore('ws-1', 'skill-1', 2);
    expect(restored?.version).toBe(2);
    expect(repo.update.mock.calls[0]![3]).toBeUndefined();
  });

  it('unknown skill or unknown version returns undefined (route -> 404)', async () => {
    const repo = makeFakeRepo(skillRow());
    repo.getById.mockResolvedValueOnce(undefined as unknown as SkillRow);
    expect(await makeService(repo).restore('ws-1', 'ghost', 1)).toBeUndefined();

    const repo2 = makeFakeRepo(skillRow());
    repo2.getVersion.mockResolvedValueOnce(undefined as never);
    expect(await makeService(repo2).restore('ws-1', 'skill-1', 99)).toBeUndefined();
    expect(repo2.update).not.toHaveBeenCalled();
  });
});

describe('SkillsService stats (GET /skills/:id/stats)', () => {
  it('reports linking agents, version count, and the newest snapshot date', async () => {
    const repo = makeFakeRepo(skillRow({ version: 2 }));
    const service = makeService(repo);

    const stats = await service.stats('ws-1', 'skill-1');

    expect(stats).toEqual({
      skill_id: 'skill-1',
      used_by_agents: 1,
      agents: [{ id: 'agent-1', name: 'API Contract Reviewer' }],
      version_count: 1,
      latest_version: 2,
      last_updated_at: '2026-08-19T00:00:00.000Z',
    });
  });

  it('unknown skill returns undefined (route -> 404)', async () => {
    const repo = makeFakeRepo(skillRow());
    repo.getById.mockResolvedValueOnce(undefined as unknown as SkillRow);
    expect(await makeService(repo).stats('ws-1', 'ghost')).toBeUndefined();
    expect(repo.agentsUsing).not.toHaveBeenCalled();
  });
});
