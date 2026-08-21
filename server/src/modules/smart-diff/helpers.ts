import type { ProposedSplit, SmartDiff, SmartDiffFile, SmartDiffGroup, SmartDiffRole } from '@devdigest/shared';
import {
  BOILERPLATE_BASENAMES,
  BOILERPLATE_SEGMENTS,
  BOILERPLATE_SUFFIXES,
  DRIZZLE_META_SEGMENT_PAIR,
  FINDING_LINE_SPAN_CAP,
  GENERATED_BASENAME_MARKER,
  GROUP_ORDER,
  MIGRATIONS_SEGMENT,
  MIN_PROPOSED_SPLITS,
  TOO_BIG_TOTAL_LINES,
  TSCONFIG_RE,
  WIRING_BARREL_BASENAMES,
  WIRING_BASENAMES,
  WIRING_CONFIG_SUFFIXES,
  WIRING_PATH_PREFIX,
  WIRING_YAML_SUFFIXES,
} from './constants.js';

/**
 * Pure Smart Diff builders (pulls/status.ts style — no DB / fastify / `this`,
 * so they unit-test cleanly). The service maps Drizzle rows to these plain
 * shapes at its boundary; no row type crosses into signatures here.
 */

/** A changed PR file, as persisted in `pr_files`. */
export interface SmartDiffFileInput {
  path: string;
  additions: number;
  deletions: number;
}

/**
 * A finding from the latest-per-agent review set (the service applies that
 * filter). Dismissed findings are excluded HERE so both concerns live where
 * they belong: review-selection in the service, line math in the builder.
 */
export interface SmartDiffFindingInput {
  file: string;
  startLine: number | null;
  endLine: number | null;
  severity: string;
  dismissedAt: Date | null;
}

/**
 * Deterministic role for a repo-relative path. Precedence:
 * boilerplate → wiring → core (default). Case-sensitive; spec 05 §4.
 */
export function classifyPath(path: string): SmartDiffRole {
  const segments = path.split('/');
  const basename = segments[segments.length - 1] ?? path;
  const dirSegments = segments.slice(0, -1);

  // ---- boilerplate (generated / mechanical) ----
  if (BOILERPLATE_BASENAMES.has(basename)) return 'boilerplate';
  if (dirSegments.some((s) => BOILERPLATE_SEGMENTS.has(s))) return 'boilerplate';
  if (BOILERPLATE_SUFFIXES.some((sfx) => basename.endsWith(sfx))) return 'boilerplate';
  if (basename.includes(GENERATED_BASENAME_MARKER)) return 'boilerplate';
  const [metaParent, metaChild] = DRIZZLE_META_SEGMENT_PAIR;
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === metaParent && segments[i + 1] === metaChild) return 'boilerplate';
  }

  // ---- wiring (hooks the core into the app) ----
  if (basename.startsWith('.')) return 'wiring'; // dotfiles: .env*, .eslintrc*, …
  if (TSCONFIG_RE.test(basename)) return 'wiring';
  if (WIRING_CONFIG_SUFFIXES.some((sfx) => basename.endsWith(sfx))) return 'wiring';
  if (WIRING_BASENAMES.has(basename)) return 'wiring';
  if (path.startsWith(WIRING_PATH_PREFIX)) return 'wiring';
  if (WIRING_YAML_SUFFIXES.some((sfx) => path.endsWith(sfx))) return 'wiring';
  if (WIRING_BARREL_BASENAMES.has(basename)) return 'wiring'; // NOT .tsx/.jsx — may be components
  if (basename.endsWith('.sql') && dirSegments.includes(MIGRATIONS_SEGMENT)) return 'wiring';

  // ---- core = everything else (tests included — reviewable business logic) ----
  return 'core';
}

/**
 * Assemble the frozen `SmartDiff` contract from plain inputs. Groups are
 * always all three roles in fixed order core→wiring→boilerplate (empty
 * `files: []` allowed); files within a group sort by findings-count desc,
 * changed-lines desc, path asc. `pseudocode_summary` stays null in v1.
 */
export function buildSmartDiff(
  files: SmartDiffFileInput[],
  findings: SmartDiffFindingInput[],
): SmartDiff {
  const active = findings.filter((f) => f.dismissedAt == null);

  // Non-dismissed findings per file — the primary sort key within a group.
  const findingCount = new Map<string, number>();
  for (const f of active) findingCount.set(f.file, (findingCount.get(f.file) ?? 0) + 1);

  const byRole: Record<SmartDiffRole, SmartDiffFile[]> = { core: [], wiring: [], boilerplate: [] };
  for (const file of files) {
    byRole[classifyPath(file.path)].push({
      path: file.path,
      pseudocode_summary: null,
      additions: file.additions,
      deletions: file.deletions,
      finding_lines: findingLinesFor(file.path, active),
    });
  }

  for (const role of GROUP_ORDER) {
    byRole[role].sort(
      (a, b) =>
        (findingCount.get(b.path) ?? 0) - (findingCount.get(a.path) ?? 0) ||
        b.additions + b.deletions - (a.additions + a.deletions) ||
        comparePaths(a.path, b.path),
    );
  }

  const groups: SmartDiffGroup[] = GROUP_ORDER.map((role) => ({ role, files: byRole[role] }));

  const totalLines = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  const tooBig = totalLines > TOO_BIG_TOTAL_LINES;

  return {
    groups,
    split_suggestion: {
      too_big: tooBig,
      total_lines: totalLines,
      proposed_splits: tooBig ? proposeSplits(groups, files) : [],
    },
  };
}

/**
 * New-file line numbers a file's non-dismissed findings anchor to:
 * `startLine .. min(endLine ?? startLine, startLine + FINDING_LINE_SPAN_CAP − 1)`,
 * deduped, ascending. Findings without a startLine are skipped (nothing to
 * anchor); a malformed endLine < startLine still yields the anchor line.
 */
function findingLinesFor(path: string, active: SmartDiffFindingInput[]): number[] {
  const lines = new Set<number>();
  for (const f of active) {
    if (f.file !== path || f.startLine == null) continue;
    const end = Math.max(
      f.startLine,
      Math.min(f.endLine ?? f.startLine, f.startLine + FINDING_LINE_SPAN_CAP - 1),
    );
    for (let ln = f.startLine; ln <= end; ln++) lines.add(ln);
  }
  return [...lines].sort((a, b) => a - b);
}

/**
 * Deterministic split proposal when the PR is too big (spec 05 §4): one split
 * per non-empty role in group order; fewer than MIN_PROPOSED_SPLITS → fall
 * back to grouping all files by first path segment; still fewer → [].
 */
function proposeSplits(groups: SmartDiffGroup[], files: SmartDiffFileInput[]): ProposedSplit[] {
  const roleSplits: ProposedSplit[] = groups
    .filter((g) => g.files.length > 0)
    .map((g) => ({ name: g.role, files: g.files.map((f) => f.path) }));
  if (roleSplits.length >= MIN_PROPOSED_SPLITS) return roleSplits;

  const bySegment = new Map<string, string[]>();
  for (const f of files) {
    const segment = f.path.split('/')[0] ?? f.path;
    const paths = bySegment.get(segment) ?? [];
    paths.push(f.path);
    bySegment.set(segment, paths);
  }
  const segmentSplits: ProposedSplit[] = [...bySegment.entries()]
    .sort(([a], [b]) => comparePaths(a, b))
    .map(([name, paths]) => ({ name, files: paths }));
  return segmentSplits.length >= MIN_PROPOSED_SPLITS ? segmentSplits : [];
}

/** Locale-independent ascending path comparison (stable across machines). */
function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
