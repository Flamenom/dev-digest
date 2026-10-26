/**
 * The shared version-anchor helper (spec
 * `specs/2026-10-23-gitlab-publish-outdated-findings.md`, AC-6 – AC-10, AC-19;
 * plan T5 / Rec3). Used by both the dialog's publish plan and the executor, so
 * the placement counts the dialog shows and the real placement cannot diverge.
 *
 * Application ring: pure apart from the injected `GitLabDiffVersionsHost`
 * port. No sibling-module, adapter, Fastify or Drizzle import.
 */
import {
  PUBLISH_VERSIONS_MAX_PAGES,
  type GitLabDiffRefs,
  type GitLabDiffVersionsHost,
  type GitLabMrDiffVersion,
  type HostRepoRef,
  type PrFileHost,
  type PublishErrorCode,
} from '@devdigest/shared';
import { generalAnchor, resolveAnchor, type AnchorableFinding, type PlannedAnchor } from './anchor.js';
import type { PersistedFileLike, PublishLogger } from './ports.js';

// ---------- Types ----------

/** Outcome of the reviewed-version lookup (AC-6, AC-8). */
export type ReviewedVersionResolution =
  | {
      kind: 'found';
      /** The version's own SHAs — never the live refs (AC-7). */
      refs: GitLabDiffRefs;
      files: PersistedFileLike[];
      versionId: number;
    }
  /** No matching version, a truncated list without a match, or a transient read failure (AC-8). */
  | { kind: 'unavailable' }
  /** 401 / 403 / 404 on a version read: the publication fails before any write (AC-8). */
  | { kind: 'fatal'; code: PublishErrorCode };

/** The anchor source `planAnchors` plans against. */
export type PlanAnchorSource =
  | { kind: 'persisted'; files: readonly PersistedFileLike[] }
  | { kind: 'none' }
  | ReviewedVersionResolution;

/** A finding as `planAnchors` needs it. */
export interface PlannableFinding extends AnchorableFinding {
  id: string;
}

// ---------- Mapping ----------

/** Host diff files (`mapRestDiff` output) → the anchor resolver's file shape. */
export function toPersistedFiles(files: readonly PrFileHost[]): PersistedFileLike[] {
  return files.map((f) => ({
    path: f.path,
    patch: f.patch ?? null,
    previousPath: f.previous_path ?? null,
    patchOmitted: f.patch_omitted ?? null,
    changeType: f.change_type ?? null,
  }));
}

// ---------- Version lookup ----------

/** Read errors that mean "no access" → the publication fails (plan Q5). */
const FATAL_READ_CODES: ReadonlySet<string> = new Set<PublishErrorCode>([
  'gitlab_token_invalid',
  'gitlab_token_insufficient_scope',
  'gitlab_project_inaccessible',
]);

/** Matched by shape, not `instanceof` (duplicate module instances, root CLAUDE.md). */
function errorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function classifyReadFailure(
  err: unknown,
  step: 'list_versions' | 'version_diff',
  log?: PublishLogger,
): Extract<ReviewedVersionResolution, { kind: 'unavailable' | 'fatal' }> {
  const code = errorCode(err);
  // Code only — never the error message / upstream body / diff text (NFR).
  log?.warn({ step, code }, 'publish: reviewed version read failed');
  if (code != null && FATAL_READ_CODES.has(code)) return { kind: 'fatal', code: code as PublishErrorCode };
  return { kind: 'unavailable' };
}

function createdAtMs(v: GitLabMrDiffVersion): number {
  const ms = Date.parse(v.createdAt);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** The newest version whose head is `headSha`: `createdAt` desc, tie → higher id. */
export function pickReviewedVersion(
  versions: readonly GitLabMrDiffVersion[],
  headSha: string,
): GitLabMrDiffVersion | null {
  let best: GitLabMrDiffVersion | null = null;
  for (const v of versions) {
    if (v.headSha !== headSha) continue;
    if (
      best == null ||
      createdAtMs(v) > createdAtMs(best) ||
      (createdAtMs(v) === createdAtMs(best) && v.id > best.id)
    ) {
      best = v;
    }
  }
  return best;
}

/**
 * AC-6 / AC-8: list the MR diff versions (≤ `PUBLISH_VERSIONS_MAX_PAGES` pages),
 * take the newest one whose head is the reviewed head, read its diff.
 * - no match (truncated list included) → `unavailable`;
 * - a read failing with a token / access code → `fatal` with that code;
 * - any other failure (transient 5xx / timeout / network, unknown) → `unavailable`.
 */
export async function resolveReviewedVersion(
  host: GitLabDiffVersionsHost,
  ref: HostRepoRef,
  iid: number,
  reviewedHeadSha: string,
  log?: PublishLogger,
): Promise<ReviewedVersionResolution> {
  let versions: GitLabMrDiffVersion[];
  try {
    ({ versions } = await host.listMrDiffVersions(ref, iid, { maxPages: PUBLISH_VERSIONS_MAX_PAGES }));
  } catch (err) {
    return classifyReadFailure(err, 'list_versions', log);
  }

  const version = pickReviewedVersion(versions, reviewedHeadSha);
  if (version == null) return { kind: 'unavailable' };

  let files: PrFileHost[];
  try {
    files = await host.getMrDiffVersionFiles(ref, iid, version.id);
  } catch (err) {
    return classifyReadFailure(err, 'version_diff', log);
  }

  return {
    kind: 'found',
    refs: { baseSha: version.baseSha, startSha: version.startSha, headSha: version.headSha },
    files: toPersistedFiles(files),
    versionId: version.id,
  };
}

// ---------- Planning ----------

/**
 * Plan every finding's anchor against the source:
 * - `none` (head unknown, AC-9) → general `review_head_unknown`;
 * - `unavailable` (AC-8) → general `reviewed_version_unavailable`;
 * - `found` / `persisted` → `resolveAnchor` (base AC-9 – AC-11, AC-10).
 * `fatal` plans nothing: the publication fails before any write.
 */
export function planAnchors(
  findings: readonly PlannableFinding[],
  source: PlanAnchorSource,
): Map<string, PlannedAnchor> {
  const planned = new Map<string, PlannedAnchor>();
  if (source.kind === 'fatal') return planned;
  for (const finding of findings) {
    switch (source.kind) {
      case 'none':
        planned.set(finding.id, generalAnchor(finding, 'review_head_unknown'));
        break;
      case 'unavailable':
        planned.set(finding.id, generalAnchor(finding, 'reviewed_version_unavailable'));
        break;
      case 'found':
      case 'persisted':
        planned.set(finding.id, resolveAnchor(finding, source.files));
        break;
    }
  }
  return planned;
}

/** Positioned (multi/single line) vs general counts of a plan (AC-21). */
export function countPlacement(planned: ReadonlyMap<string, PlannedAnchor>): {
  positioned: number;
  general: number;
} {
  let positioned = 0;
  let general = 0;
  for (const anchor of planned.values()) {
    if (anchor.kind === 'general') general += 1;
    else positioned += 1;
  }
  return { positioned, general };
}
