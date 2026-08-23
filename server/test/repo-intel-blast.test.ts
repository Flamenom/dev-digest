/**
 * L04 — repo-intel facade blast changes (hermetic; plan T2).
 *
 * 1. `tryPersistentBlast` per-symbol caller cap: MAX_CALLERS_PER_SYMBOL (20) is
 *    a PER-CHANGED-SYMBOL cap, not a global slice — a symbol with a huge
 *    fan-out must not starve the callers of the next symbol.
 * 2. `getReverseDependents` BFS over mocked `getReverseEdges`: depth-2 reach,
 *    visited dedup, changed-file exclusion, facts filtering, flag-off → [].
 *
 * Same pattern as repo-intel-facade-degraded.test.ts: the service is built on
 * a stub container and its private `repo` is patched — no Postgres, no clone.
 * (The real getReverseEdges SQL is exercised by blast.it.test.ts.)
 */
import { describe, it, expect, vi } from 'vitest';
import { RepoIntelService } from '../src/modules/repo-intel/service.js';
import { MAX_CALLERS_PER_SYMBOL } from '../src/modules/repo-intel/constants.js';
import type { IndexerEdgeRow } from '../src/modules/repo-intel/types.js';

function buildService(opts: { flag?: boolean; repo: Record<string, unknown> }): RepoIntelService {
  const container = {
    config: { repoIntelEnabled: opts.flag ?? true },
    db: {} as never,
  } as never;
  const svc = new RepoIntelService(container);
  (svc as unknown as { repo: Record<string, unknown> }).repo = opts.repo;
  return svc;
}

describe('getBlastRadius (persistent path) — per-symbol caller cap', () => {
  it('caps callers at 20 PER changed symbol; a >20 fan-out does not starve the other symbol', async () => {
    const changed = ['src/a.ts'];
    // alpha: 25 callers from 25 distinct files, ranks 25..1 (desc-identifiable).
    const alphaCallers = Array.from({ length: 25 }, (_, i) => ({
      fromPath: `src/callers/c${String(i).padStart(2, '0')}.ts`,
      toSymbol: 'alpha',
      line: 10 + i,
      rank: 25 - i,
    }));
    // beta: 3 callers, ALL ranked below every alpha caller — a global rank-desc
    // slice(0, 20) would keep only alpha rows and starve beta entirely.
    const betaCallers = [
      { fromPath: 'src/beta/b1.ts', toSymbol: 'beta', line: 1, rank: 0.3 },
      { fromPath: 'src/beta/b2.ts', toSymbol: 'beta', line: 2, rank: 0.2 },
      { fromPath: 'src/beta/b3.ts', toSymbol: 'beta', line: 3, rank: 0.1 },
    ];

    const svc = buildService({
      repo: {
        tryGetIndexState: async () => ({ status: 'full' }),
        // First call: decls in changed files. Later call: caller files (no
        // symbol rows → enclosing falls back to the file basename).
        getSymbolRows: async (_repoId: string, paths: string[]) =>
          paths.includes('src/a.ts')
            ? [
                { path: 'src/a.ts', name: 'alpha', kind: 'function', line: 1, endLine: 5, exported: true, signature: null },
                { path: 'src/a.ts', name: 'beta', kind: 'function', line: 7, endLine: 12, exported: true, signature: null },
              ]
            : [],
        getResolvedCallers: async () => [...alphaCallers, ...betaCallers],
        getFileFacts: async () => [],
      },
    });

    const blast = await svc.getBlastRadius('r1', changed);

    expect(blast.degraded).toBe(false);
    expect(blast.changedSymbols.map((s) => s.name)).toEqual(['alpha', 'beta']);

    const alpha = blast.callers.filter((c) => c.viaSymbol === 'alpha');
    const beta = blast.callers.filter((c) => c.viaSymbol === 'beta');

    // Cap applies per symbol…
    expect(alpha).toHaveLength(MAX_CALLERS_PER_SYMBOL);
    // …keeping each group's HIGHEST-ranked callers (ranks 25..6 survive).
    expect(alpha.map((c) => c.rank)).toEqual(
      Array.from({ length: MAX_CALLERS_PER_SYMBOL }, (_, i) => 25 - i),
    );
    // …and beta is NOT starved by alpha's fan-out.
    expect(beta).toHaveLength(3);
    expect(beta.map((c) => c.file)).toEqual(['src/beta/b1.ts', 'src/beta/b2.ts', 'src/beta/b3.ts']);
  });
});

describe('getReverseDependents — BFS over file_edges', () => {
  /**
   * Graph (edges point from importer → imported):
   *   b.ts → a.ts        (depth 1)
   *   c.ts → a.ts        (depth 1)
   *   c.ts → b.ts        (already visited at depth 1 → dedup, stays depth 1)
   *   a.ts → b.ts        (a is a CHANGED file → excluded even though it imports b)
   *   d.ts → c.ts        (depth 2)
   *   e.ts → d.ts        (depth 3 — never queried at maxDepth 2)
   */
  const edgesByTarget: Record<string, IndexerEdgeRow[]> = {
    'a.ts': [
      { fromFile: 'b.ts', toFile: 'a.ts' },
      { fromFile: 'c.ts', toFile: 'a.ts' },
    ],
    'b.ts': [
      { fromFile: 'c.ts', toFile: 'b.ts' },
      { fromFile: 'a.ts', toFile: 'b.ts' },
    ],
    'c.ts': [{ fromFile: 'd.ts', toFile: 'c.ts' }],
    'd.ts': [{ fromFile: 'e.ts', toFile: 'd.ts' }],
  };
  const factsForAll = [
    { filePath: 'b.ts', endpoints: ['GET /b'], crons: [] },
    // c has NO facts → filtered out of the result.
    { filePath: 'c.ts', endpoints: [], crons: [] },
    { filePath: 'd.ts', endpoints: [], crons: ['daily-report'] },
  ];

  function bfsService(flag = true) {
    const getReverseEdges = vi.fn(async (_repoId: string, toFiles: string[]) =>
      toFiles.flatMap((f) => edgesByTarget[f] ?? []),
    );
    const getFileFacts = vi.fn(async (_repoId: string, files: string[]) =>
      factsForAll.filter((f) => files.includes(f.filePath)),
    );
    return {
      svc: buildService({ flag, repo: { getReverseEdges, getFileFacts } }),
      getReverseEdges,
      getFileFacts,
    };
  }

  it('walks to depth 2, dedups visited files, excludes changed files, filters fact-less files', async () => {
    const { svc, getReverseEdges } = bfsService();
    const rows = await svc.getReverseDependents('r1', ['a.ts']);

    expect(rows.toSorted((x, y) => x.file.localeCompare(y.file))).toEqual([
      { file: 'b.ts', depth: 1, endpoints: ['GET /b'], crons: [] },
      { file: 'd.ts', depth: 2, endpoints: [], crons: ['daily-report'] },
    ]);
    // a.ts (changed) is never a dependent; c.ts was deduped to depth 1 and then
    // dropped for having no facts; e.ts (depth 3) was never even queried.
    expect(rows.map((r) => r.file)).not.toContain('a.ts');
    expect(rows.map((r) => r.file)).not.toContain('e.ts');

    // One indexed query per BFS level: [a] then [b, c] — exactly two.
    expect(getReverseEdges).toHaveBeenCalledTimes(2);
    expect(getReverseEdges).toHaveBeenNthCalledWith(1, 'r1', ['a.ts']);
    expect(getReverseEdges).toHaveBeenNthCalledWith(2, 'r1', ['b.ts', 'c.ts']);
  });

  it('maxDepth 1 stops after the first level', async () => {
    const { svc, getReverseEdges } = bfsService();
    const rows = await svc.getReverseDependents('r1', ['a.ts'], 1);

    expect(rows).toEqual([{ file: 'b.ts', depth: 1, endpoints: ['GET /b'], crons: [] }]);
    expect(getReverseEdges).toHaveBeenCalledTimes(1);
  });

  it('flag off / empty input / non-positive depth → [] without touching the repository', async () => {
    const off = bfsService(false);
    await expect(off.svc.getReverseDependents('r1', ['a.ts'])).resolves.toEqual([]);
    expect(off.getReverseEdges).not.toHaveBeenCalled();

    const on = bfsService();
    await expect(on.svc.getReverseDependents('r1', [])).resolves.toEqual([]);
    await expect(on.svc.getReverseDependents('r1', ['a.ts'], 0)).resolves.toEqual([]);
    expect(on.getReverseEdges).not.toHaveBeenCalled();
  });
});
