/**
 * L04 — BlastService (hermetic; docs/plans/l04-blast-radius.md T6).
 *
 * The service takes an explicit deps object (composition-root pattern), so the
 * tests inject vi.fn() fakes directly — no Postgres, no app. Covers the four
 * status paths (ok / partial / degraded / empty), the ACCEPTANCE-CRITICAL gate
 * (degraded must NOT call getBlastRadius — no AST/index work at request time),
 * per-symbol caller grouping, endpoint/cron attribution via factsByFile, the
 * depth-1 + depth-2 endpoint union with dedup, counts, and `summary` always null.
 */
import { describe, it, expect, vi } from 'vitest';
import { BlastService, type BlastServiceDeps } from '../src/modules/blast/service.js';
import { NotFoundError } from '../src/platform/errors.js';

const WS = 'ws-1';
const PR = 'pr-uuid-1';
const REPO = 'repo-uuid-1';

const FULL_STATE = { status: 'full', filesIndexed: 10, filesSkipped: 0 };

/** Deps where everything succeeds on the happy path; override per test. */
function makeDeps(overrides: {
  repoIntelEnabled?: boolean;
  indexState?: { status: string; filesIndexed: number; filesSkipped: number; reason?: string };
  blast?: Partial<Awaited<ReturnType<BlastServiceDeps['repoIntel']['getBlastRadius']>>>;
  reverse?: Awaited<ReturnType<BlastServiceDeps['repoIntel']['getReverseDependents']>>;
  prFiles?: Array<{ path: string }>;
  pull?: { id: string; repoId: string } | undefined;
  priorPrs?: Awaited<ReturnType<BlastServiceDeps['blastRepo']['getPriorPrs']>>;
}) {
  const deps = {
    repoIntelEnabled: overrides.repoIntelEnabled ?? true,
    repoIntel: {
      getIndexState: vi.fn().mockResolvedValue(overrides.indexState ?? FULL_STATE),
      getBlastRadius: vi.fn().mockResolvedValue({
        changedSymbols: [],
        callers: [],
        impactedEndpoints: [],
        factsByFile: {},
        degraded: false,
        ...overrides.blast,
      }),
      getReverseDependents: vi.fn().mockResolvedValue(overrides.reverse ?? []),
    },
    repo: {
      getPull: vi
        .fn()
        .mockResolvedValue('pull' in overrides ? overrides.pull : { id: PR, repoId: REPO }),
      getPrFiles: vi.fn().mockResolvedValue(overrides.prFiles ?? [{ path: 'src/money.ts' }]),
    },
    blastRepo: {
      getPriorPrs: vi.fn().mockResolvedValue(overrides.priorPrs ?? []),
    },
  } satisfies BlastServiceDeps;
  return deps;
}

describe('BlastService — status paths and the no-AST-at-request-time gate', () => {
  it('unknown pull → NotFoundError', async () => {
    const deps = makeDeps({ pull: undefined });
    await expect(new BlastService(deps).get(WS, PR)).rejects.toThrow(NotFoundError);
  });

  it('flag off → declared degraded: empty arrays, reason, and ZERO repo-intel calls', async () => {
    const deps = makeDeps({ repoIntelEnabled: false });
    const res = await new BlastService(deps).get(WS, PR);

    expect(res.status).toBe('degraded');
    expect(res.reason).toMatch(/REPO_INTEL_ENABLED/);
    expect(res.symbols).toEqual([]);
    expect(res.endpoints).toEqual([]);
    expect(res.prior_prs).toEqual([]);
    expect(res.counts).toEqual({ symbols: 0, callers: 0, endpoints: 0, crons: 0 });
    expect(res.summary).toBeNull();

    // Acceptance criterion: nothing is computed — especially no blast call.
    expect(deps.repoIntel.getIndexState).not.toHaveBeenCalled();
    expect(deps.repoIntel.getBlastRadius).not.toHaveBeenCalled();
    expect(deps.repoIntel.getReverseDependents).not.toHaveBeenCalled();
  });

  it.each(['degraded', 'failed'] as const)(
    'index state %s → degraded WITHOUT calling getBlastRadius (no AST parsing at request time)',
    async (status) => {
      const deps = makeDeps({
        indexState: { status, filesIndexed: 0, filesSkipped: 0, reason: 'clone missing' },
      });
      const res = await new BlastService(deps).get(WS, PR);

      expect(res.status).toBe('degraded');
      // The reason surfaces both the state and its explanation.
      expect(res.reason).toContain(status);
      expect(res.reason).toContain('clone missing');

      expect(deps.repoIntel.getBlastRadius).not.toHaveBeenCalled();
      expect(deps.repoIntel.getReverseDependents).not.toHaveBeenCalled();
      expect(deps.blastRepo.getPriorPrs).not.toHaveBeenCalled();
    },
  );

  it('state race: state says full but the facade degraded mid-flight → degraded, no reverse BFS', async () => {
    const deps = makeDeps({ blast: { degraded: true, reason: 'no_data' } });
    const res = await new BlastService(deps).get(WS, PR);

    expect(res.status).toBe('degraded');
    expect(res.reason).toContain('no_data');
    expect(res.symbols).toEqual([]);
    expect(deps.repoIntel.getReverseDependents).not.toHaveBeenCalled();
  });

  it('empty: no symbols in changed files → status empty with the "no symbols" reason, prior PRs still attached', async () => {
    const prior = [
      { number: 3, title: 'Old refactor', author: 'dev', status: 'merged', files_overlap: ['src/money.ts'] },
    ];
    const deps = makeDeps({ blast: { changedSymbols: [] }, priorPrs: prior });
    const res = await new BlastService(deps).get(WS, PR);

    expect(res.status).toBe('empty');
    expect(res.reason).toMatch(/no symbols are declared/);
    expect(res.prior_prs).toEqual(prior);
    expect(res.counts).toEqual({ symbols: 0, callers: 0, endpoints: 0, crons: 0 });
  });

  it('empty: PR with zero changed files → the "no changed files" reason', async () => {
    const deps = makeDeps({ prFiles: [] });
    const res = await new BlastService(deps).get(WS, PR);

    expect(res.status).toBe('empty');
    expect(res.reason).toMatch(/no changed files/);
  });
});

describe('BlastService — ok path: grouping, attribution, union, counts', () => {
  /** Two changed symbols; alpha has two caller files, beta shares one of them. */
  const BLAST = {
    changedSymbols: [
      { file: 'src/a.ts', name: 'alpha', kind: 'function' },
      { file: 'src/b.ts', name: 'beta', kind: 'class' },
    ],
    callers: [
      { file: 'src/api/routes.ts', symbol: 'handler', viaSymbol: 'alpha', line: 10, rank: 0.9 },
      { file: 'src/jobs/cron.ts', symbol: 'job', viaSymbol: 'alpha', line: 5, rank: 0.5 },
      { file: 'src/api/routes.ts', symbol: 'handler2', viaSymbol: 'beta', line: 30, rank: 0.9 },
    ],
    impactedEndpoints: ['GET /users', 'POST /users'],
    factsByFile: {
      'src/api/routes.ts': { endpoints: ['GET /users', 'POST /users'], crons: [] },
      'src/jobs/cron.ts': { endpoints: [], crons: ['nightly-cleanup'] },
    },
    degraded: false,
  };
  const REVERSE = [
    // Same endpoint+file as depth 1 → must be DEDUPED (depth-1 entry wins).
    { file: 'src/api/routes.ts', depth: 1, endpoints: ['GET /users'], crons: [] },
    // Genuinely new depth-2 file with an endpoint and a cron.
    { file: 'src/app.ts', depth: 2, endpoints: ['GET /health'], crons: ['weekly-report'] },
  ];

  it('groups callers per symbol, attributes endpoints/crons via factsByFile, unions depth-1/2 endpoints', async () => {
    const prior = [
      { number: 7, title: 'Related', author: 'dev', status: 'open', files_overlap: ['src/a.ts'] },
    ];
    // Duplicate pr_files path — the service must dedupe changedFiles.
    const deps = makeDeps({
      blast: BLAST,
      reverse: REVERSE,
      prFiles: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/a.ts' }],
      priorPrs: prior,
      indexState: FULL_STATE,
    });
    const res = await new BlastService(deps).get(WS, PR);

    expect(res.status).toBe('ok');
    expect(res.reason).toBeNull();
    expect(res.summary).toBeNull();

    // Changed files deduped before hitting the facade + prior-PRs SQL.
    expect(deps.repoIntel.getBlastRadius).toHaveBeenCalledWith(REPO, ['src/a.ts', 'src/b.ts'], { persistentOnly: true });
    expect(deps.blastRepo.getPriorPrs).toHaveBeenCalledWith(REPO, PR, ['src/a.ts', 'src/b.ts']);
    // Reverse BFS uses the facade's default depth (single source of truth).
    expect(deps.repoIntel.getReverseDependents).toHaveBeenCalledWith(REPO, ['src/a.ts', 'src/b.ts']);

    // --- Per-symbol grouping + attribution. --------------------------------
    expect(res.symbols).toHaveLength(2);
    const [alpha, beta] = res.symbols;
    expect(alpha!.symbol).toEqual({ name: 'alpha', file: 'src/a.ts', kind: 'function' });
    expect(alpha!.callers).toEqual([
      { file: 'src/api/routes.ts', line: 10, symbol: 'handler', rank: 0.9 },
      { file: 'src/jobs/cron.ts', line: 5, symbol: 'job', rank: 0.5 },
    ]);
    // alpha reaches both caller files → union of both files' facts.
    expect(alpha!.endpoints_affected.toSorted()).toEqual(['GET /users', 'POST /users']);
    expect(alpha!.crons_affected).toEqual(['nightly-cleanup']);

    // beta only reaches routes.ts → no cron attributed.
    expect(beta!.callers).toEqual([
      { file: 'src/api/routes.ts', line: 30, symbol: 'handler2', rank: 0.9 },
    ]);
    expect(beta!.endpoints_affected.toSorted()).toEqual(['GET /users', 'POST /users']);
    expect(beta!.crons_affected).toEqual([]);

    // --- Endpoint union: depth 1 first, depth-2 additions, dup dropped. ----
    expect(res.endpoints.toSorted((a, b) => a.endpoint.localeCompare(b.endpoint))).toEqual([
      { endpoint: 'GET /health', file: 'src/app.ts', depth: 2 },
      { endpoint: 'GET /users', file: 'src/api/routes.ts', depth: 1 }, // deduped: depth-1 wins
      { endpoint: 'POST /users', file: 'src/api/routes.ts', depth: 1 },
    ]);

    // --- Counts over the AGGREGATED data. -----------------------------------
    expect(res.counts).toEqual({
      symbols: 2,
      callers: 3,
      endpoints: 3,
      crons: 2, // nightly-cleanup (depth 1) + weekly-report (depth 2)
    });

    expect(res.prior_prs).toEqual(prior);
  });

  it('partial index → status partial with a files-indexed/skipped reason, data still computed', async () => {
    const deps = makeDeps({
      indexState: { status: 'partial', filesIndexed: 12, filesSkipped: 3 },
      blast: BLAST,
      reverse: [],
      prFiles: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
    });
    const res = await new BlastService(deps).get(WS, PR);

    expect(res.status).toBe('partial');
    expect(res.reason).toContain('12');
    expect(res.reason).toContain('3');
    expect(res.symbols).toHaveLength(2); // partial still serves data
    expect(res.counts.callers).toBe(3);
  });

  it('symbol with no callers keeps an empty group (not dropped, nothing attributed)', async () => {
    const deps = makeDeps({
      blast: {
        changedSymbols: [
          { file: 'src/a.ts', name: 'alpha', kind: 'function' },
          { file: 'src/a.ts', name: 'lonely', kind: 'function' },
        ],
        callers: [
          { file: 'src/api/routes.ts', symbol: 'handler', viaSymbol: 'alpha', line: 10, rank: 0.9 },
        ],
        impactedEndpoints: ['GET /users'],
        factsByFile: { 'src/api/routes.ts': { endpoints: ['GET /users'], crons: [] } },
        degraded: false,
      },
    });
    const res = await new BlastService(deps).get(WS, PR);

    const lonely = res.symbols.find((s) => s.symbol.name === 'lonely');
    expect(lonely).toBeDefined();
    expect(lonely!.callers).toEqual([]);
    expect(lonely!.endpoints_affected).toEqual([]);
    expect(lonely!.crons_affected).toEqual([]);
    expect(res.counts).toEqual({ symbols: 2, callers: 1, endpoints: 1, crons: 0 });
  });
});
