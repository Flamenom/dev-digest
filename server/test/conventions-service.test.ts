import { describe, it, expect, vi } from 'vitest';
import { ConventionsService } from '../src/modules/conventions/service.js';
import type { ConventionsRepository, ConventionRow } from '../src/modules/conventions/repository.js';
import type { Container } from '../src/platform/container.js';
import { MockLLMProvider } from '../src/adapters/mocks.js';
import { NotFoundError, ValidationError } from '../src/platform/errors.js';

/**
 * Hermetic tests for the extraction flow (no DB, no network): the 2-step LLM
 * dialogue (fixtures keyed by schemaName, the shape MockLLMProvider anticipates),
 * config probing via git.readFile, hallucinated-selection filtering, and the
 * grounding gate wired into persistence (`replaceForRepo` + `upsertScan`).
 */

const USERS_TS =
  'export async function getUser(id: string) {\n' +
  '  const user = await db.users.find(id);\n' +
  '  return user;\n' +
  '}\n';

const CLONE_FILES: Record<string, string> = {
  'package.json': '{ "type": "module" }\n',
  'src/api/users.ts': USERS_TS,
  'src/api/posts.ts': 'export const posts = [];\n',
};

function makeFakeRepo() {
  let seq = 0;
  return {
    getRepo: vi.fn(async () => ({
      id: 'repo-1',
      owner: 'acme',
      name: 'payments-api',
      fullName: 'acme/payments-api',
    })),
    listByRepo: vi.fn(async () => []),
    replaceForRepo: vi.fn(
      async (workspaceId: string, repoId: string, rows: Record<string, unknown>[]) =>
        rows.map(
          (r) =>
            ({
              id: `conv-${++seq}`,
              workspaceId,
              repoId,
              rule: r.rule,
              evidencePath: r.evidencePath,
              evidenceSnippet: r.evidenceSnippet,
              confidence: r.confidence,
              accepted: false,
              category: r.category,
              status: 'pending',
              evidenceStartLine: r.evidenceStartLine,
              evidenceEndLine: r.evidenceEndLine,
              createdAt: new Date('2026-08-19T00:00:00Z'),
            }) as ConventionRow,
        ),
    ),
    updateById: vi.fn(),
    bulkSetStatus: vi.fn(async () => 3),
    upsertScan: vi.fn(async () => undefined),
    getScan: vi.fn(async () => ({
      id: 'scan-1',
      workspaceId: 'ws-1',
      repoId: 'repo-1',
      sampledFileCount: 3,
      droppedCount: 1,
      scannedAt: new Date('2026-08-19T00:00:00Z'),
    })),
  };
}

function makeContainer(opts: {
  pool?: string[];
  structuredBySchema?: Record<string, unknown>;
  llm?: MockLLMProvider;
}) {
  const llm =
    opts.llm ?? new MockLLMProvider('openai', { structuredBySchema: opts.structuredBySchema });
  const container = {
    // resolveFeatureModel reads workspace settings; empty rows → registry default.
    db: { select: () => ({ from: () => ({ where: async () => [] }) }) },
    repoIntel: {
      getConventionSamples: vi.fn(async () => opts.pool ?? ['src/api/users.ts', 'src/api/posts.ts']),
    },
    git: {
      readFile: vi.fn(async (_repo: unknown, path: string) => {
        const content = CLONE_FILES[path];
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      }),
    },
    llm: vi.fn(async () => llm),
  };
  return { container: container as unknown as Container, llm, fakes: container };
}

const SELECTION_FIXTURE = { files: ['src/api/users.ts'] };
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
      rule: 'Fabricated rule with no real evidence',
      evidence_path: 'src/api/users.ts',
      evidence_snippet: 'const fabricated = neverInFile();',
      confidence: 0.8,
    },
  ],
};

describe('ConventionsService.extract', () => {
  it('runs the 2-step dialogue, grounds candidates, persists kept rows + scan stats', async () => {
    const fakeRepo = makeFakeRepo();
    const { container, llm } = makeContainer({
      structuredBySchema: {
        ConventionFileSelection: SELECTION_FIXTURE,
        ConventionExtraction: EXTRACTION_FIXTURE,
      },
    });
    const service = new ConventionsService(container, fakeRepo as unknown as ConventionsRepository);

    const result = await service.extract('ws-1', 'repo-1');

    // 2 structured calls, in schema order.
    const schemaNames = llm.calls
      .filter((c) => c.method === 'completeStructured')
      .map((c) => (c.req as { schemaName: string }).schemaName);
    expect(schemaNames).toEqual(['ConventionFileSelection', 'ConventionExtraction']);

    // Grounded candidate persisted as pending with resolved lines; fabricated one dropped.
    expect(fakeRepo.replaceForRepo).toHaveBeenCalledWith('ws-1', 'repo-1', [
      expect.objectContaining({
        rule: 'Always use async/await instead of .then() chains',
        evidencePath: 'src/api/users.ts',
        evidenceStartLine: 2,
        evidenceEndLine: 2,
      }),
    ]);
    // package.json (config probe) + selected users.ts = 2 sampled files.
    expect(fakeRepo.upsertScan).toHaveBeenCalledWith('ws-1', 'repo-1', {
      sampledFileCount: 2,
      droppedCount: 1,
    });
    expect(result.conventions).toHaveLength(1);
    expect(result.conventions[0]!.status).toBe('pending');
    expect(result.stats.droppedCount).toBe(1);
  });

  it('filters hallucinated selection paths and falls back to the ranked pool', async () => {
    const fakeRepo = makeFakeRepo();
    const { container, fakes } = makeContainer({
      structuredBySchema: {
        ConventionFileSelection: { files: ['../../etc/passwd', 'src/made-up.ts'] },
        ConventionExtraction: { conventions: [] },
      },
    });
    const service = new ConventionsService(container, fakeRepo as unknown as ConventionsRepository);

    await service.extract('ws-1', 'repo-1');

    // Hallucinated paths never reach git.readFile; the pool fallback does.
    const readPaths = fakes.git.readFile.mock.calls.map((c) => c[1]);
    expect(readPaths).not.toContain('../../etc/passwd');
    expect(readPaths).toContain('src/api/users.ts');
    expect(readPaths).toContain('src/api/posts.ts');
  });

  it('throws ValidationError when the repo has no ranked samples (not indexed)', async () => {
    const fakeRepo = makeFakeRepo();
    const { container } = makeContainer({ pool: [] });
    const service = new ConventionsService(container, fakeRepo as unknown as ConventionsRepository);
    await expect(service.extract('ws-1', 'repo-1')).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws NotFoundError for a repo outside the workspace', async () => {
    const fakeRepo = makeFakeRepo();
    fakeRepo.getRepo.mockResolvedValueOnce(undefined as never);
    const { container } = makeContainer({});
    const service = new ConventionsService(container, fakeRepo as unknown as ConventionsRepository);
    await expect(service.extract('ws-1', 'repo-x')).rejects.toBeInstanceOf(NotFoundError);
  });
});
