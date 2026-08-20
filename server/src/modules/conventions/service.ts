import type {
  Convention,
  ConventionExtractResponse,
  ConventionListResponse,
  ConventionScanStats,
  ConventionStatus,
  RepoRef,
  UpdateConventionBody,
} from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import { NotFoundError, ValidationError } from '../../platform/errors.js';
import { resolveFeatureModel } from '../settings/feature-models.js';
import { ConventionsRepository } from './repository.js';
import { toConventionDto } from './helpers.js';
import {
  CONFIG_FILE_CANDIDATES,
  MAX_CONFIG_FILES,
  SAMPLE_TOP_N,
  SELECTION_POOL_N,
} from './constants.js';
import {
  ConventionExtraction,
  ConventionFileSelection,
  buildExtractionMessages,
  buildSelectionMessages,
} from './prompts.js';
import { groundConventions } from './grounding.js';

/**
 * Conventions Extractor — sample the cloned repo (configs + top-ranked files),
 * run the 2-step LLM dialogue (select files → extract candidates), ground every
 * candidate's evidence against the sampled contents (ungrounded → dropped),
 * persist as `pending` rows replacing the previous scan.
 *
 * Extraction runs synchronously in the request (2 LLM calls); all the work
 * lives in `extract()` so wrapping it in a job handler later is a routes-only
 * change.
 */
export class ConventionsService {
  private repo: ConventionsRepository;

  constructor(
    private container: Container,
    repo?: ConventionsRepository,
  ) {
    this.repo = repo ?? new ConventionsRepository(container.db);
  }

  async list(workspaceId: string, repoId: string): Promise<ConventionListResponse> {
    const repo = await this.repo.getRepo(workspaceId, repoId);
    if (!repo) throw new NotFoundError('Repo not found');
    const [rows, scan] = await Promise.all([
      this.repo.listByRepo(workspaceId, repoId),
      this.repo.getScan(workspaceId, repoId),
    ]);
    return {
      conventions: rows.map(toConventionDto),
      stats: scan ? toStats(scan) : null,
    };
  }

  async extract(workspaceId: string, repoId: string): Promise<ConventionExtractResponse> {
    const repo = await this.repo.getRepo(workspaceId, repoId);
    if (!repo) throw new NotFoundError('Repo not found');
    const repoRef: RepoRef = { owner: repo.owner, name: repo.name };

    const poolPaths = await this.container.repoIntel.getConventionSamples(
      repoId,
      SELECTION_POOL_N,
    );
    if (poolPaths.length === 0) {
      throw new ValidationError('Repo is not indexed yet — run indexing first');
    }

    // Configs are probed directly: repo-intel's sampler excludes them by design.
    const files = new Map<string, string>();
    for (const candidate of CONFIG_FILE_CANDIDATES) {
      if (files.size >= MAX_CONFIG_FILES) break;
      try {
        files.set(candidate, await this.container.git.readFile(repoRef, candidate));
      } catch {
        // absent — skip
      }
    }

    const { provider, model } = await resolveFeatureModel(
      this.container,
      workspaceId,
      'conventions',
    );
    const llm = await this.container.llm(provider);

    // Step 1: the model picks which pool files to read. Hallucinated or
    // traversal paths are dropped by intersecting with what we offered.
    const selection = await llm.completeStructured({
      model,
      schema: ConventionFileSelection,
      schemaName: 'ConventionFileSelection',
      messages: buildSelectionMessages(poolPaths),
    });
    const offered = new Set(poolPaths);
    let selected = selection.data.files.filter((p) => offered.has(p));
    if (selected.length === 0) selected = poolPaths.slice(0, SAMPLE_TOP_N);

    for (const path of selected.slice(0, SAMPLE_TOP_N)) {
      try {
        files.set(path, await this.container.git.readFile(repoRef, path));
      } catch {
        // unreadable (deleted since indexing, binary, …) — skip
      }
    }
    const sampledFileCount = files.size;

    // Step 2: extract candidates, then ground each one against the exact
    // contents the model saw — the user-visible "grounded against sampled
    // files" guarantee.
    const extraction = await llm.completeStructured({
      model,
      schema: ConventionExtraction,
      schemaName: 'ConventionExtraction',
      messages: buildExtractionMessages(files),
    });
    const grounded = groundConventions(extraction.data.conventions, files);

    const rows = await this.repo.replaceForRepo(
      workspaceId,
      repoId,
      grounded.kept.map((k) => ({
        category: k.category,
        rule: k.rule,
        evidencePath: k.evidence_path,
        evidenceSnippet: k.evidence_snippet,
        evidenceStartLine: k.evidence_start_line,
        evidenceEndLine: k.evidence_end_line,
        confidence: k.confidence,
      })),
    );
    await this.repo.upsertScan(workspaceId, repoId, {
      sampledFileCount,
      droppedCount: grounded.dropped.length,
    });

    const scan = await this.repo.getScan(workspaceId, repoId);
    // Same order the list endpoint returns (confidence desc, stable ties), so
    // the client's setQueryData(extract result) matches later refetches.
    const sorted = [...rows].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    return {
      conventions: sorted.map(toConventionDto),
      stats: scan
        ? toStats(scan)
        : { sampledFileCount, droppedCount: grounded.dropped.length, lastScanAt: new Date().toISOString() },
    };
  }

  async update(
    workspaceId: string,
    id: string,
    body: UpdateConventionBody,
  ): Promise<Convention | undefined> {
    const row = await this.repo.updateById(workspaceId, id, body);
    return row ? toConventionDto(row) : undefined;
  }

  async bulkStatus(
    workspaceId: string,
    repoId: string,
    status: ConventionStatus,
  ): Promise<{ updated: number }> {
    const repo = await this.repo.getRepo(workspaceId, repoId);
    if (!repo) throw new NotFoundError('Repo not found');
    return { updated: await this.repo.bulkSetStatus(workspaceId, repoId, status) };
  }
}

function toStats(scan: {
  sampledFileCount: number;
  droppedCount: number;
  scannedAt: Date;
}): ConventionScanStats {
  return {
    sampledFileCount: scan.sampledFileCount,
    droppedCount: scan.droppedCount,
    lastScanAt: scan.scannedAt.toISOString(),
  };
}
