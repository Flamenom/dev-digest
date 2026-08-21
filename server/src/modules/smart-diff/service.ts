import type { SmartDiff } from '@devdigest/shared';
import { NotFoundError } from '../../platform/errors.js';
import { buildSmartDiff, type SmartDiffFindingInput } from './helpers.js';

/**
 * L0x — Smart Diff service. Computes the risk-ordered file view ON READ from
 * already-persisted `pr_files` + the latest findings — deterministic, zero
 * LLM, zero persistence (spec 05 §3/§5). Before the first review the findings
 * input is simply `[]`: grouping works, `finding_lines` stay empty.
 */

// Structural projections of the rows the service consumes — the repository's
// Drizzle row types satisfy these without leaking $inferSelect inward
// (reviews/intent-deriver.ts precedent).
export interface SmartDiffPull {
  id: string;
}

export interface SmartDiffPrFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface SmartDiffReview {
  id: string;
  agentId: string | null;
  kind: string;
}

export interface SmartDiffFindingRow {
  file: string;
  startLine: number | null;
  endLine: number | null;
  severity: string;
  dismissedAt: Date | null;
}

/** Explicit deps object — built in the composition root, never `Container`. */
export interface SmartDiffServiceDeps {
  repo: {
    getPull(workspaceId: string, prId: string): Promise<SmartDiffPull | undefined>;
    getPrFiles(prId: string): Promise<SmartDiffPrFile[]>;
    /** Reviews for a PR (NEWEST FIRST), each with its findings. */
    reviewsForPull(
      prId: string,
    ): Promise<{ review: SmartDiffReview; findings: SmartDiffFindingRow[] }[]>;
  };
}

export class SmartDiffService {
  constructor(private deps: SmartDiffServiceDeps) {}

  /** The Smart Diff for a PR, tenancy-scoped; missing PR → NotFoundError. */
  async get(workspaceId: string, prId: string): Promise<SmartDiff> {
    const pull = await this.deps.repo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');

    const prFiles = await this.deps.repo.getPrFiles(prId);
    const reviews = await this.deps.repo.reviewsForPull(prId);

    // Latest review per (prId, agentId): kind='review', rows are newest-first
    // so first-seen per agent wins; agent-less reviews key on their own id —
    // exactly the pulls/routes.ts rollup rule (INSIGHTS: "the latest review"
    // alone picks an arbitrary agent).
    const seenAgent = new Set<string>();
    const findings: SmartDiffFindingInput[] = [];
    for (const { review, findings: rows } of reviews) {
      if (review.kind !== 'review') continue;
      const key = review.agentId ?? review.id;
      if (seenAgent.has(key)) continue;
      seenAgent.add(key);
      for (const f of rows) {
        findings.push({
          file: f.file,
          startLine: f.startLine,
          endLine: f.endLine,
          severity: f.severity,
          dismissedAt: f.dismissedAt,
        });
      }
    }

    const files = prFiles.map((f) => ({
      path: f.path,
      additions: f.additions,
      deletions: f.deletions,
    }));

    return buildSmartDiff(files, findings);
  }
}
