import { createHash } from 'node:crypto';
import type { BlastStatus, PrBriefGeneration } from '@devdigest/shared';

/**
 * Pure helpers for the PR Brief slice (spec `specs/2026-08-27-pr-brief.md`).
 *
 * No I/O, no Drizzle, no Fastify, no `this` — plain structural inputs in, plain
 * values out (`smart-diff/helpers.ts` style), so every rule here unit-tests
 * without Postgres. The service maps rows to these shapes at its boundary.
 *
 * What lives here:
 *  - the cache fingerprint (AC-4) and its stale explanation (AC-5),
 *  - the allowed-reference set (AC-10) and the grounding gate over model output
 *    (AC-11, AC-12, AC-13),
 *  - the two patch-header projections the brief is allowed to read (Q2 and the
 *    changed-line ranges AC-12 tests against) — NEVER a hunk body (AC-2, N6),
 *  - the nullable spend sum (AC-19).
 *
 * `changedLineRangesFromPatch` intentionally duplicates a little of
 * `reviews/intent-helpers.ts`: `no-cross-module` forbids importing a sibling
 * module's folder, and the two projections answer different questions (hunk
 * HEADERS for the prompt there, new-file RANGES for grounding here).
 */

/** `risk_level` is derived from the deterministic score, never from the model (AC-16a, [D1]). */
export { riskLevelFromScore, RISK_LEVEL_BANDS } from '@devdigest/shared';

// ---------------------------------------------------------------- fingerprint

/**
 * Everything the cache key covers, and nothing else (AC-4, [D4]).
 *
 * AC-41 is enforced STRUCTURALLY: there is no field here for a finding action,
 * so accepting / dismissing / learning-from / replying-to a finding cannot move
 * the fingerprint. Do not add one.
 */
export interface FingerprintInput {
  /** The intent's head SHA; null when the PR was never classified (AC-32). */
  intentHeadSha: string | null;
  /** The intent's `generated_at` (ISO); null when there is no intent. */
  intentGeneratedAt: string | null;
  /** Blast `status`; null when the blast response could not be produced at all. */
  blastStatus: BlastStatus | null;
  /** Blast `counts` verbatim; null when there is no blast response. */
  blastCounts: {
    symbols: number;
    callers: number;
    endpoints: number;
    crons: number;
  } | null;
  /** `reviews.id` of the per-agent-latest review set. Order-insensitive. */
  latestReviewIds: readonly string[];
}

/**
 * Stable sha256 over the generation inputs (AC-4).
 *
 * Stability rules that must not change without invalidating every cached brief:
 * keys are written in a FIXED order (never `JSON.stringify` of an object built
 * elsewhere — key order there is insertion order), and the review-id set is
 * SORTED so the DB's row order can never flip the hash.
 */
export function computeInputFingerprint(input: FingerprintInput): string {
  const canonical = JSON.stringify([
    ['intent_head_sha', input.intentHeadSha],
    ['intent_generated_at', input.intentGeneratedAt],
    ['blast_status', input.blastStatus],
    [
      'blast_counts',
      input.blastCounts == null
        ? null
        : [
            input.blastCounts.symbols,
            input.blastCounts.callers,
            input.blastCounts.endpoints,
            input.blastCounts.crons,
          ],
    ],
    ['review_ids', [...input.latestReviewIds].sort()],
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** The PR state a brief was generated for: head SHA + input fingerprint (AC-4). */
export interface BriefState {
  headSha: string;
  fingerprint: string;
}

/** The same pair as read back from storage — null on a row written before 0016. */
export interface CachedBriefState {
  headSha: string | null;
  fingerprint: string | null;
}

/** First 7 chars, the git short-SHA convention; short/absent values pass through. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Why a cached brief no longer matches the PR state — a human-readable sentence
 * naming what moved (AC-5), or `null` when the brief is current.
 *
 * Callers derive `stale` from this: `stale = staleReason(...) !== null`. Staleness
 * is DATA, never a trigger: nothing here regenerates or bills (N5, [D4]).
 *
 * Only two distinctions are possible by construction — the head SHA is stored
 * verbatim, while every other input is collapsed into one hash — so the inputs
 * branch names the three candidates rather than guessing between them.
 */
export function staleReason(current: BriefState, cached: CachedBriefState): string | null {
  if (cached.headSha == null || cached.fingerprint == null) {
    return 'This brief was generated before the PR state was recorded, so it cannot be checked for freshness.';
  }

  const moved: string[] = [];
  if (cached.headSha !== current.headSha) {
    moved.push(
      `the PR head moved from ${shortSha(cached.headSha)} to ${shortSha(current.headSha)}`,
    );
  }
  if (cached.fingerprint !== current.fingerprint) {
    moved.push('its inputs changed (declared intent, blast radius or review results)');
  }
  if (moved.length === 0) return null;
  return `This brief is out of date: ${moved.join(', and ')}.`;
}

// ------------------------------------------------------------- patch headers

/** A contiguous NEW-FILE line range touched by one hunk, inclusive at both ends. */
export interface LineRange {
  start: number;
  end: number;
}

/**
 * New-file line ranges of a stored patch, read from `@@ -a,b +c,d @@` headers ONLY.
 *
 * This is the AC-12 oracle: "the entry's line falls inside a changed line range
 * of that file". A hunk with `+c,0` (a pure deletion) adds no new-file line and
 * is skipped; a header without a count (`+c`) means exactly one line. Absent or
 * empty patch → `[]`, which correctly grounds nothing.
 *
 * Only the header is parsed — the hunk BODY is never read, so AC-2 / N6 hold.
 */
export function changedLineRangesFromPatch(patch: string | null | undefined): LineRange[] {
  if (!patch) return [];
  const ranges: LineRange[] = [];
  for (const line of patch.split('\n')) {
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (!Number.isFinite(start) || count <= 0) continue;
    ranges.push({ start, end: start + count - 1 });
  }
  return ranges;
}

/** True when `line` falls inside any of the ranges (inclusive). */
export function lineInRanges(line: number, ranges: readonly LineRange[]): boolean {
  return ranges.some((r) => line >= r.start && line <= r.end);
}

/** How a file participates in the PR diff, as shown in the prompt statistics (AC-2). */
export type PrFileChangeType = 'added' | 'deleted' | 'renamed' | 'modified';

/**
 * Change type derived from the patch HEADER only (Q2 default) — `pr_files` has
 * no change-type column, and reading `new file mode` / `deleted file mode` /
 * `rename from` is not reading a hunk body, so AC-2's exclusion holds.
 *
 * The scan stops at the first hunk header: everything after `@@` is diff content.
 * A null patch (GitHub omits it for binary or oversized files) → `modified`.
 */
export function changeTypeFromPatch(patch: string | null | undefined): PrFileChangeType {
  if (!patch) return 'modified';
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) break;
    if (line.startsWith('new file mode')) return 'added';
    if (line.startsWith('deleted file mode')) return 'deleted';
    if (line.startsWith('rename from')) return 'renamed';
  }
  return 'modified';
}

// ------------------------------------------------------- allowed-reference set

/** A PR file as the allowed-set builder needs it: path + patch header material. */
export interface AllowedRefsFileInput {
  path: string;
  patch: string | null;
}

/**
 * The slice of the blast response the allowed set reads. Structural on purpose —
 * `BlastResponse` is assignable to it, and the helper stays testable without one.
 */
export interface AllowedRefsBlastInput {
  status: BlastStatus;
  symbols: readonly {
    symbol: { file: string };
    callers: readonly { file: string; line: number }[];
  }[];
  endpoints: readonly { file: string }[];
}

/**
 * A grounded finding, already mapped from `findings.file` to the contract's `path`.
 *
 * `id` is load-bearing, not decoration: it is the ONLY source of truth for a
 * review-focus entry's `finding_id` ([D3] — "present only when the entry
 * corresponds to an input finding"), so an id the model invented or carried over
 * from another PR is nulled out by `groundGeneration`.
 */
export interface AllowedRefsFindingInput {
  id: string;
  path: string;
}

export interface AllowedRefsInput {
  changedFiles: readonly AllowedRefsFileInput[];
  /** Null when no blast response could be obtained at all. */
  blast: AllowedRefsBlastInput | null;
  findings: readonly AllowedRefsFindingInput[];
}

/**
 * The allowed-reference set for a PR (AC-10), derived from diff + blast +
 * findings alone — no repository walk, ever.
 *
 *  - `files`      — every citable path: changed files ∪ blast files ∪ finding files.
 *  - `diffLines`  — path → changed NEW-FILE ranges, for the AC-12 diff branch.
 *  - `blastLines` — path → reported CALLER lines, for the AC-12 blast branch.
 *  - `findingIds` — the ids a review-focus entry may claim to correspond to ([D3]).
 *
 * AC-33: a `degraded` or `empty` blast contributes NOTHING — not even its paths —
 * so the set narrows to changed files + finding files and the caller records the
 * blast reason as a missing input.
 *
 * Q3: `BlastResponse` carries a line only on `symbols[].callers[].line`.
 * `ChangedSymbol` and `BlastEndpointRef` are line-less, so a symbol-declaration or
 * endpoint file with no caller line contributes its PATH (AC-10) but no line — a
 * review-focus entry there is dropped by AC-12, while a path-scoped risk ref on it
 * survives (AC-11).
 */
export function buildAllowedRefs(input: AllowedRefsInput): AllowedRefs {
  const files = new Set<string>();
  const diffLines = new Map<string, LineRange[]>();
  const blastLines = new Map<string, Set<number>>();
  const findingIds = new Set<string>();

  for (const file of input.changedFiles) {
    files.add(file.path);
    diffLines.set(file.path, changedLineRangesFromPatch(file.patch));
  }

  const blast = input.blast;
  if (blast && blast.status !== 'degraded' && blast.status !== 'empty') {
    for (const impact of blast.symbols) {
      files.add(impact.symbol.file);
      for (const caller of impact.callers) {
        files.add(caller.file);
        const lines = blastLines.get(caller.file) ?? new Set<number>();
        lines.add(caller.line);
        blastLines.set(caller.file, lines);
      }
    }
    for (const endpoint of blast.endpoints) files.add(endpoint.file);
  }

  for (const finding of input.findings) {
    files.add(finding.path);
    findingIds.add(finding.id);
  }

  return { files, diffLines, blastLines, findingIds };
}

export interface AllowedRefs {
  /** Every path a risk ref or focus entry may cite (AC-10, AC-11). */
  files: Set<string>;
  /** Changed new-file ranges per PR-diff path (AC-12, diff branch). */
  diffLines: Map<string, LineRange[]>;
  /** Reported caller lines per blast path (AC-12, blast branch; Q3). */
  blastLines: Map<string, Set<number>>;
  /**
   * `findings.id` of the PR's grounded findings — the only ids a review-focus
   * entry's `finding_id` may reference ([D3]). Note this set is NOT narrowed by
   * a degraded blast (AC-33): findings are an independent input.
   */
  findingIds: Set<string>;
}

// ------------------------------------------------------------- grounding gate

/** What survives grounding: the model's two reference-bearing sections, filtered. */
export type GroundedGeneration = Pick<PrBriefGeneration, 'risks' | 'review_focus'>;

/**
 * Is `path` citable at all (AC-11)?  Grounding DROPS, it never repairs: nothing
 * here rewrites a path, snaps a line to the nearest hunk or substitutes a
 * placeholder.
 */
function pathAllowed(path: string, allowed: AllowedRefs): boolean {
  return allowed.files.has(path);
}

/**
 * Is `path:line` citable (AC-12)?
 *  - the path is part of the PR diff → the line must fall inside a changed range;
 *  - the path is present only in the blast response → the line must match a
 *    reported caller line (Q3: symbol/endpoint files report none, so they fail).
 *
 * A path reachable ONLY through a finding has no line source either, so a focus
 * entry on it is dropped too. In practice findings are anchored to diff lines by
 * the review pipeline's own grounding gate, so this branch is an edge case, not
 * the normal path.
 */
function lineAllowed(path: string, line: number, allowed: AllowedRefs): boolean {
  const ranges = allowed.diffLines.get(path);
  if (ranges !== undefined) return lineInRanges(line, ranges);
  return allowed.blastLines.get(path)?.has(line) ?? false;
}

/**
 * The brief-local grounding gate over MODEL output (AC-11, AC-12, AC-13).
 *
 * This is NOT the review pipeline's grounding gate (`reviewer-core/src/grounding.ts`),
 * which it neither replaces nor relaxes — this one verifies the brief's own
 * references against the allowed set before anything is persisted.
 *
 *  - a risk keeps only refs whose PATH is allowed (risk refs are path-scoped);
 *    a risk left with zero refs is dropped whole — an ungrounded risk would render
 *    a row with no file reference, which AC-22 forbids;
 *  - a review-focus entry must satisfy BOTH the path rule and the line rule;
 *  - a review-focus entry's `finding_id` must name one of the PR's OWN grounded
 *    findings, else it is nulled — see below;
 *  - a section whose every entry was discarded persists as `[]` — the key is
 *    always present, so the UI renders the section's empty state (AC-13).
 *
 * WHY an unrecognised `finding_id` NULLS the field instead of dropping the entry:
 * the contract says `finding_id` is "present only when the entry corresponds to
 * an input finding" ([D3]), and the client dispatches on it — a model-invented or
 * cross-PR id would send `onGoToFinding` at a target that does not exist, a
 * silent no-op. The path/line reference is still legitimate, so the entry
 * degrades to file-target navigation (AC-29) rather than vanishing. Nulling is a
 * DROP of the id, not a repair: nothing here remaps an id to a nearby finding.
 *
 * Entry ORDER is preserved: the review focus is the model's reading order and is
 * deliberately never re-ranked.
 */
export function groundGeneration(
  generation: GroundedGeneration,
  allowed: AllowedRefs,
): GroundedGeneration {
  const risks: GroundedGeneration['risks'] = [];
  for (const risk of generation.risks) {
    const refs = risk.refs.filter((ref) => pathAllowed(ref.path, allowed));
    if (refs.length === 0) continue;
    risks.push({ ...risk, refs });
  }

  const review_focus: GroundedGeneration['review_focus'] = [];
  for (const entry of generation.review_focus) {
    if (!pathAllowed(entry.path, allowed)) continue;
    if (!lineAllowed(entry.path, entry.line, allowed)) continue;
    // Normalised to `null` rather than left `undefined` so the persisted blob has
    // one representation of "no linked finding" regardless of what the model sent.
    const finding_id =
      entry.finding_id != null && allowed.findingIds.has(entry.finding_id)
        ? entry.finding_id
        : null;
    review_focus.push({ ...entry, finding_id });
  }

  return { risks, review_focus };
}

// ----------------------------------------------------------- missing inputs

/**
 * The missing-input notes a READ can recompute from live state, and must
 * therefore never serve from the cache (AC-32, AC-33, AC-34).
 *
 * Their absence is as meaningful as their presence: once a PR is classified, the
 * `intent` note has to disappear even though the cached brief really was written
 * without an intent. Everything NOT listed here is a one-time fact about the
 * generation itself (`linked_issue`, `repo_doc`, NFR-3's `diff_statistics`) that
 * only the generation could observe, so it is served from storage.
 */
export const LIVE_RECOMPUTED_MISSING_INPUTS: ReadonlySet<string> = new Set([
  'intent',
  'blast_radius',
  'reviews',
]);

/**
 * The `missing_inputs` a read serves: the live-recomputed notes, plus the
 * persisted one-time notes of the generation that produced the cached content.
 *
 * Deduped by the `input` key with LIVE winning — a stale persisted note for a
 * live-recomputable input is discarded outright, never merely reordered, so the
 * card cannot claim intent is missing after the PR has been classified.
 */
export function mergeMissingInputs<T extends { input: string }>(
  live: readonly T[],
  persisted: readonly T[],
): T[] {
  const seen = new Set(live.map((m) => m.input));
  const oneTime = persisted.filter(
    (m) => !LIVE_RECOMPUTED_MISSING_INPUTS.has(m.input) && !seen.has(m.input),
  );
  return [...live, ...oneTime];
}

// ------------------------------------------------------------------ PR spend

/** One priced model call's contribution to the PR total (an `agent_runs` / intent / brief row). */
export interface SpendEntry {
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

/** Total recorded PR spend; each field is null when NOTHING recorded that metric. */
export interface PrSpend {
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

/** Sum of the non-null values, or null when there is not a single one (AC-19). */
function sumOrNull(values: readonly (number | null)[]): number | null {
  let total: number | null = null;
  for (const value of values) {
    if (value == null) continue;
    total = (total ?? 0) + value;
  }
  return total;
}

/**
 * Total PR model spend: review runs + intent classifications + brief generations
 * (AC-9, [D5]).
 *
 * The null semantics are the point (AC-19): a PR whose calls all returned an
 * unknown cost must yield `null` so the card renders a muted em dash, NEVER
 * `$0.00` — those mean different things, and `0` would claim a free review. Each
 * metric is independent: a provider can report tokens without a price.
 */
export function sumSpend(entries: readonly SpendEntry[]): PrSpend {
  return {
    costUsd: sumOrNull(entries.map((e) => e.costUsd)),
    tokensIn: sumOrNull(entries.map((e) => e.tokensIn)),
    tokensOut: sumOrNull(entries.map((e) => e.tokensOut)),
  };
}
