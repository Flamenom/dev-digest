import { describe, it, expect, vi } from 'vitest';
import { AgentsService } from '../src/modules/agents/service.js';
import type { AgentsRepository, AgentRow } from '../src/modules/agents/repository.js';
import { SkillsService } from '../src/modules/skills/service.js';
import type { SkillsRepository, SkillRow } from '../src/modules/skills/repository.js';
import type { Container } from '../src/platform/container.js';

/**
 * Hermetic attach-docs tests (AC-9/AC-14/AC-16), at the SERVICE level with
 * faked repositories (the repository bodies are Drizzle queries — covered by
 * `.it.test.ts` integration tests elsewhere; the rules under test here are the
 * service/helpers contracts):
 *  - `setAttachedDocs` persists the ordered path list (paths only, never text),
 *  - it never routes through the versioning `update` path — `version` (and a
 *    skill's `evidence_files`) stay untouched,
 *  - the DTO mappers expose the list as `attached_doc_paths`.
 *
 * NOTE: AgentsService constructs its own repository from `container.db`, so the
 * fake is swapped in on the private field — tests only; no production change.
 */

function agentRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 'agent-1',
    workspaceId: 'ws-1',
    name: 'API Contract Reviewer',
    description: '',
    provider: 'openai',
    model: 'gpt-4.1',
    systemPrompt: 'You review API contracts.',
    outputSchema: null,
    strategy: 'single-pass',
    ciFailOn: 'critical',
    repoIntel: true,
    attachedDocPaths: [],
    enabled: true,
    version: 3,
    createdBy: null,
    createdAt: new Date('2026-08-18T00:00:00Z'),
    ...overrides,
  } as AgentRow;
}

function skillRow(overrides: Partial<SkillRow> = {}): SkillRow {
  return {
    id: 'skill-1',
    workspaceId: 'ws-1',
    name: 'branch-coverage-rubric',
    description: 'Judge tests by branches.',
    type: 'rubric',
    source: 'extracted',
    body: 'v1 body',
    attachedDocPaths: [],
    enabled: true,
    version: 2,
    evidenceFiles: ['src/a.test.ts', 'src/b.test.ts'],
    createdAt: new Date('2026-08-18T00:00:00Z'),
    ...overrides,
  } as SkillRow;
}

function makeAgentsService(existing: AgentRow) {
  const repo = {
    // Echo the targeted update like the real repository: paths replaced,
    // version untouched, nothing else changed.
    setAttachedDocs: vi.fn(async (_ws: string, _id: string, paths: string[]) => ({
      ...existing,
      attachedDocPaths: paths,
    })),
    update: vi.fn(),
    getById: vi.fn(async () => existing),
  };
  const service = new AgentsService({ db: {} } as unknown as Container);
  (service as unknown as { repo: AgentsRepository }).repo = repo as unknown as AgentsRepository;
  return { service, repo };
}

function makeSkillsService(existing: SkillRow) {
  const repo = {
    setAttachedDocs: vi.fn(async (_ws: string, _id: string, paths: string[]) => ({
      ...existing,
      attachedDocPaths: paths,
    })),
    update: vi.fn(),
    getById: vi.fn(async () => existing),
  };
  const service = new SkillsService({} as Container, repo as unknown as SkillsRepository);
  return { service, repo };
}

describe('AgentsService.setAttachedDocs', () => {
  it('persists the ordered path list and maps it to attached_doc_paths (AC-9)', async () => {
    const { service, repo } = makeAgentsService(agentRow());
    const paths = ['docs/z-last.md', 'specs/a-first.md', 'insights/mid.md'];

    const agent = await service.setAttachedDocs('ws-1', 'agent-1', paths);

    // The repository receives the EXACT ordered list (order = attach order).
    expect(repo.setAttachedDocs).toHaveBeenCalledWith('ws-1', 'agent-1', paths);
    expect(agent?.attached_doc_paths).toEqual(paths);
  });

  it('never bumps version and never routes through the versioning update (AC-14)', async () => {
    const { service, repo } = makeAgentsService(agentRow({ version: 3 }));

    const agent = await service.setAttachedDocs('ws-1', 'agent-1', ['docs/spec.md']);

    expect(agent?.version).toBe(3); // unchanged
    expect(repo.update).not.toHaveBeenCalled(); // no snapshot path
  });

  it('detaching everything persists [] without touching version', async () => {
    const { service, repo } = makeAgentsService(
      agentRow({ attachedDocPaths: ['docs/a.md'], version: 5 }),
    );
    const agent = await service.setAttachedDocs('ws-1', 'agent-1', []);
    expect(repo.setAttachedDocs).toHaveBeenCalledWith('ws-1', 'agent-1', []);
    expect(agent?.attached_doc_paths).toEqual([]);
    expect(agent?.version).toBe(5);
  });

  it('unknown agent in this workspace → undefined (route → 404)', async () => {
    const { service, repo } = makeAgentsService(agentRow());
    repo.setAttachedDocs.mockResolvedValueOnce(undefined as unknown as AgentRow);
    expect(await service.setAttachedDocs('ws-1', 'ghost', ['docs/a.md'])).toBeUndefined();
  });
});

describe('SkillsService.setAttachedDocs', () => {
  it('persists the ordered path list — paths only, never document text (AC-16)', async () => {
    const { service, repo } = makeSkillsService(skillRow());
    const paths = ['specs/b.md', 'docs/a.md'];

    const skill = await service.setAttachedDocs('ws-1', 'skill-1', paths);

    expect(repo.setAttachedDocs).toHaveBeenCalledWith('ws-1', 'skill-1', paths);
    expect(skill?.attached_doc_paths).toEqual(paths); // order preserved
  });

  it('is NOT a body change: version and evidence_files stay untouched (AC-14)', async () => {
    const { service, repo } = makeSkillsService(
      skillRow({ version: 2, evidenceFiles: ['src/a.test.ts', 'src/b.test.ts'] }),
    );

    const skill = await service.setAttachedDocs('ws-1', 'skill-1', ['docs/spec.md']);

    expect(skill?.version).toBe(2); // unchanged
    expect(skill?.evidence_files).toEqual(['src/a.test.ts', 'src/b.test.ts']); // unchanged
    expect(repo.update).not.toHaveBeenCalled(); // no version bump / snapshot path
  });

  it('unknown skill in this workspace → undefined (route → 404)', async () => {
    const { service, repo } = makeSkillsService(skillRow());
    repo.setAttachedDocs.mockResolvedValueOnce(undefined as unknown as SkillRow);
    expect(await service.setAttachedDocs('ws-1', 'ghost', ['docs/a.md'])).toBeUndefined();
  });
});
