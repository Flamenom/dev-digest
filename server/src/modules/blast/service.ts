import type {
  BlastCallerRef,
  BlastEndpointRef,
  BlastPriorPr,
  BlastResponse,
  BlastStatus,
  BlastSymbolImpact,
} from '@devdigest/shared';
import { NotFoundError } from '../../platform/errors.js';

/**
 * L04 — Blast Radius service. Computes "what can this PR break" ON READ from
 * the repo-intel persistent index + local pr_files — deterministic, zero LLM,
 * zero persistence (smart-diff pattern; client caches via TanStack Query).
 *
 * ACCEPTANCE-CRITICAL GATE: the service only calls `getBlastRadius` when the
 * index state is `full`/`partial`. Any other state (or the feature flag off)
 * returns a DECLARED `degraded` response with empty arrays — it never lets the
 * facade's best-effort fallback re-parse the clone at request time.
 */

// Structural projections — the concrete facade/repositories satisfy these
// without a cross-module type import (smart-diff/service.ts precedent).
export interface BlastPull {
  id: string;
  repoId: string;
}

export interface BlastPrFile {
  path: string;
}

export interface BlastIndexState {
  status: string;
  filesIndexed: number;
  filesSkipped: number;
  reason?: string;
}

export interface BlastRadiusData {
  changedSymbols: Array<{ file: string; name: string; kind: string }>;
  callers: Array<{ file: string; symbol: string; viaSymbol: string; line: number; rank: number }>;
  impactedEndpoints: string[];
  factsByFile?: Record<string, { endpoints: string[]; crons: string[] }>;
  degraded?: boolean;
  reason?: string;
}

export interface BlastReverseDependent {
  file: string;
  depth: number;
  endpoints: string[];
  crons: string[];
}

/** Explicit deps object — built in the composition root, never `Container`. */
export interface BlastServiceDeps {
  repoIntelEnabled: boolean;
  repoIntel: {
    getIndexState(repoId: string): Promise<BlastIndexState>;
    getBlastRadius(
      repoId: string,
      changedFiles: string[],
      opts?: { persistentOnly?: boolean },
    ): Promise<BlastRadiusData>;
    getReverseDependents(
      repoId: string,
      files: string[],
      maxDepth?: number,
    ): Promise<BlastReverseDependent[]>;
  };
  repo: {
    getPull(workspaceId: string, prId: string): Promise<BlastPull | undefined>;
    getPrFiles(prId: string): Promise<BlastPrFile[]>;
  };
  blastRepo: {
    getPriorPrs(repoId: string, prId: string, changedFiles: string[]): Promise<BlastPriorPr[]>;
  };
}

export class BlastService {
  constructor(private deps: BlastServiceDeps) {}

  /** The blast radius for a PR, tenancy-scoped; missing PR → NotFoundError. */
  async get(workspaceId: string, prId: string): Promise<BlastResponse> {
    const pull = await this.deps.repo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');

    const prFiles = await this.deps.repo.getPrFiles(prId);
    const changedFiles = [...new Set(prFiles.map((f) => f.path))];

    // --- Gate 1: feature flag. Declared degraded — no data computed. --------
    if (!this.deps.repoIntelEnabled) {
      return emptyResponse(
        'degraded',
        'repo-intel is disabled — enable REPO_INTEL_ENABLED and index the repository.',
      );
    }

    // --- Gate 2: index state. Only full/partial may serve blast data. -------
    const state = await this.deps.repoIntel.getIndexState(pull.repoId);
    if (state.status !== 'full' && state.status !== 'partial') {
      return emptyResponse(
        'degraded',
        state.reason
          ? `the repository index is unusable (${state.status}: ${state.reason}) — re-index the repository.`
          : `the repository index is not built yet (${state.status}) — index the repository first.`,
      );
    }

    // persistentOnly: even if the index degrades between the state read above
    // and this call, the facade returns degraded instead of falling back to
    // clone parsing — the "no AST at request time" criterion holds structurally.
    const blast = await this.deps.repoIntel.getBlastRadius(pull.repoId, changedFiles, {
      persistentOnly: true,
    });
    if (blast.degraded) {
      // State said usable, but the facade degraded mid-flight (state race).
      return emptyResponse(
        'degraded',
        blast.reason
          ? `the index became unavailable (${blast.reason}) — re-index the repository.`
          : 'the index became unavailable — re-index the repository.',
      );
    }

    const priorPrs = await this.deps.blastRepo.getPriorPrs(pull.repoId, prId, changedFiles);

    if (blast.changedSymbols.length === 0) {
      const reason =
        changedFiles.length === 0
          ? 'the PR has no changed files.'
          : 'no symbols are declared in the changed files.';
      return { ...emptyResponse('empty', reason), prior_prs: priorPrs };
    }

    // --- Per-symbol grouping (callers arrive per-symbol-capped, rank desc). --
    const factsByFile = blast.factsByFile ?? {};
    const callersBySymbol = new Map<string, BlastCallerRef[]>();
    const callerFilesBySymbol = new Map<string, Set<string>>();
    for (const c of blast.callers) {
      let arr = callersBySymbol.get(c.viaSymbol);
      if (!arr) callersBySymbol.set(c.viaSymbol, (arr = []));
      arr.push({ file: c.file, line: c.line, symbol: c.symbol, rank: c.rank });
      let files = callerFilesBySymbol.get(c.viaSymbol);
      if (!files) callerFilesBySymbol.set(c.viaSymbol, (files = new Set()));
      files.add(c.file);
    }

    const symbols: BlastSymbolImpact[] = blast.changedSymbols.map((s) => {
      const endpoints = new Set<string>();
      const crons = new Set<string>();
      for (const file of callerFilesBySymbol.get(s.name) ?? []) {
        const facts = factsByFile[file];
        if (!facts) continue;
        for (const e of facts.endpoints) endpoints.add(e);
        for (const c of facts.crons) crons.add(c);
      }
      return {
        symbol: { name: s.name, file: s.file, kind: s.kind },
        callers: callersBySymbol.get(s.name) ?? [],
        endpoints_affected: [...endpoints],
        crons_affected: [...crons],
      };
    });

    // --- Endpoint union: depth 1 (caller files) + depth ≤2 (reverse imports).
    const endpointRefs: BlastEndpointRef[] = [];
    const seenEndpoint = new Set<string>();
    const addEndpoint = (endpoint: string, file: string, depth: number) => {
      const key = `${endpoint}|${file}`;
      if (seenEndpoint.has(key)) return;
      seenEndpoint.add(key);
      endpointRefs.push({ endpoint, file, depth });
    };
    for (const [file, facts] of Object.entries(factsByFile)) {
      for (const e of facts.endpoints) addEndpoint(e, file, 1);
    }

    const cronSet = new Set<string>();
    for (const s of symbols) for (const c of s.crons_affected) cronSet.add(c);

    // Default maxDepth = the facade's BFS_DEPTH (2) — single source of truth.
    const reverse = await this.deps.repoIntel.getReverseDependents(pull.repoId, changedFiles);
    for (const r of reverse) {
      for (const e of r.endpoints) addEndpoint(e, r.file, r.depth);
      for (const c of r.crons) cronSet.add(c);
    }

    const callerCount = symbols.reduce((n, s) => n + s.callers.length, 0);
    const status: BlastStatus = state.status === 'partial' ? 'partial' : 'ok';
    return {
      status,
      reason:
        status === 'partial'
          ? `partial index (${state.filesIndexed} files indexed, ${state.filesSkipped} skipped) — results may be incomplete.`
          : null,
      counts: {
        symbols: symbols.length,
        callers: callerCount,
        endpoints: endpointRefs.length,
        crons: cronSet.size,
      },
      symbols,
      endpoints: endpointRefs,
      prior_prs: priorPrs,
      summary: null, // reserved for a future LLM step — no model call today
    };
  }
}

/** Declared non-ok state: empty arrays + a reason, never masked as data. */
function emptyResponse(status: BlastStatus, reason: string): BlastResponse {
  return {
    status,
    reason,
    counts: { symbols: 0, callers: 0, endpoints: 0, crons: 0 },
    symbols: [],
    endpoints: [],
    prior_prs: [],
    summary: null,
  };
}
