/* helpers.ts — pure logic behind the eval case editor (screen F).

   Everything the editor "knows" lives here, so the component body only wires
   state to JSX: JSON validity (AC-14), the `must_find` hunk warnings (AC-13),
   the `+ Finding skeleton` template, and the record <-> draft mapping. No
   React, no I/O, no `@devdigest/ui` — importable and testable on its own
   (`helpers.test.ts`).

   Security (A05): the `Expected output` editor is parsed with `JSON.parse` +
   `EvalExpectedOutput.safeParse` and NEVER `eval`'d. Its content is persisted
   as data and travels to the model only as the pinned diff / PR description the
   runner assembles server-side — it is never concatenated into a system prompt.

   Why the diff is scanned here at all: the AC-13 warning needs the case's own
   hunks, and the server's `parseUnifiedDiff` is not reachable from the browser.
   This is deliberately a MINIMAL `@@`-header scan (new-side start + count) and
   not a diff parser — it never reconstructs file content, and the authoritative
   answer is always the server's (`empty_diff` at run time). */

import { EvalExpectedOutput } from "@devdigest/shared";
import type {
  EvalCaseDraft,
  EvalCaseFromFindingInput,
  EvalCaseInput,
  EvalCaseRecord,
  EvalExpectation,
  EvalPrMeta,
} from "@devdigest/shared";
import { FALLBACK_RUN_COUNT, JSON_INDENT, SKELETON_FILE } from "./constants";

/* ------------------------------------------------------------------ paths */

/**
 * The six-step normalization of spec §4.1, mirrored client-side so the editor's
 * warning agrees with the server's match rule. **Case-sensitive** on purpose:
 * git is, and folding case would let `SRC/Config.ts` silently satisfy an
 * expectation on `src/config.ts`.
 */
export function normalizeDiffPath(raw: string): string {
  let out = raw.replace(/\\/g, "/").trim();
  // 3. a leading `a/` or `b/` is a git prefix — but only when something remains.
  const unprefixed = out.replace(/^[ab]\//, "");
  if (unprefixed.length > 0) out = unprefixed;
  // 4. `./` repeatedly.
  while (out.startsWith("./")) out = out.slice(2);
  // 5. collapse `//` runs, 6. drop a leading `/`.
  out = out.replace(/\/{2,}/g, "/");
  if (out.startsWith("/")) out = out.slice(1);
  return out;
}

/* ------------------------------------------------------------------- diff */

/** One `@@` hunk, as a closed inclusive interval of NEW-side line numbers. */
export interface DiffHunk {
  file: string;
  start: number;
  end: number;
}

/** What the minimal scan can say about a diff. */
export interface DiffScan {
  /** Distinct normalized new-side paths, in first-seen order. */
  files: string[];
  hunks: DiffHunk[];
}

const EMPTY_SCAN: DiffScan = { files: [], hunks: [] };

/** `+++ b/src/config.ts` (optionally followed by a tab-separated timestamp). */
const NEW_SIDE_FILE_RE = /^\+\+\+ (.+)$/;
/** `@@ -12,7 +12,9 @@ …` — only the new-side start and count are read. */
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Minimal `@@`-header scan: every `+++` line opens a file, every `@@` header
 * under it contributes `[start, start + count - 1]` on the new side. A hunk
 * with `count === 0` is a pure deletion and adds no new-side line, so it is
 * skipped; `+++ /dev/null` (a deleted file) opens no file at all.
 */
export function scanDiffHunks(diff: string): DiffScan {
  if (!diff) return EMPTY_SCAN;
  const files: string[] = [];
  const hunks: DiffHunk[] = [];
  let current: string | null = null;

  for (const line of diff.split(/\r?\n/)) {
    const fileMatch = NEW_SIDE_FILE_RE.exec(line);
    if (fileMatch) {
      // Unified diff may append `\t<timestamp>` after the path.
      const path = normalizeDiffPath((fileMatch[1] ?? "").split("\t")[0] ?? "");
      current = path === "dev/null" || path.length === 0 ? null : path;
      if (current && !files.includes(current)) files.push(current);
      continue;
    }
    if (current === null) continue;
    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (!hunkMatch) continue;
    const start = Number(hunkMatch[1]);
    const count = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
    if (!Number.isFinite(start) || !Number.isFinite(count) || count <= 0) continue;
    hunks.push({ file: current, start, end: start + count - 1 });
  }
  return { files, hunks };
}

/* --------------------------------------------------------- expected output */

/** `safeParse` result, narrowed to what the editor actually branches on. */
export type ParsedExpectedOutput =
  | { ok: true; value: EvalExpectedOutput }
  | { ok: false };

/**
 * AC-14's single source of truth: the editor's `Expected output` text is valid
 * iff it is JSON **and** it parses as `EvalExpectedOutput`. Called during
 * render — never mirrored into state.
 */
export function parseExpectedOutput(text: string): ParsedExpectedOutput {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return { ok: false };
  }
  const parsed = EvalExpectedOutput.safeParse(json);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

/** One AC-13 warning: a `must_find` range that misses every hunk of its file. */
export interface ExpectationWarning {
  /** The path exactly as the user typed it (the warning must be recognisable). */
  file: string;
  start: number;
  end: number;
}

/**
 * AC-13 — every `must_find` expectation whose closed inclusive `[lo, hi]` range
 * intersects no hunk of the same file in the case's own diff. `must_not_flag`
 * expectations are exempt: asserting that the agent stays silent about a region
 * the diff does not touch is unusual but not wrong.
 */
export function findExpectationWarnings(
  expected: EvalExpectedOutput | null,
  scan: DiffScan,
): ExpectationWarning[] {
  if (!expected || expected.kind !== "must_find") return [];
  const warnings: ExpectationWarning[] = [];
  for (const expectation of expected.expectations) {
    const other = expectation.end_line ?? expectation.start_line;
    const lo = Math.min(expectation.start_line, other);
    const hi = Math.max(expectation.start_line, other);
    const file = normalizeDiffPath(expectation.file);
    const covered = scan.hunks.some((h) => h.file === file && lo <= h.end && h.start <= hi);
    if (!covered) warnings.push({ file: expectation.file, start: lo, end: hi });
  }
  return warnings;
}

/** Pretty-print for the JSON editor — the one place the indent is chosen. */
export function stringifyExpectedOutput(value: EvalExpectedOutput): string {
  return JSON.stringify(value, null, JSON_INDENT);
}

/**
 * `+ Finding skeleton` — append a valid one-expectation template. When the
 * current text already parses, the skeleton EXTENDS it (kind preserved);
 * otherwise it replaces the unparseable text with a fresh `must_find` case, so
 * the button is always a way back to valid JSON. The seed points at the diff's
 * first hunk when there is one, so the fresh expectation does not immediately
 * trip the AC-13 warning.
 */
export function withFindingSkeleton(text: string, scan: DiffScan): string {
  const firstHunk = scan.hunks[0];
  const seed: EvalExpectation = {
    file: scan.files[0] ?? SKELETON_FILE,
    start_line: firstHunk?.start ?? 1,
    end_line: firstHunk?.end ?? 1,
  };
  const parsed = parseExpectedOutput(text);
  const next: EvalExpectedOutput = parsed.ok
    ? { kind: parsed.value.kind, expectations: [...parsed.value.expectations, seed] }
    : { kind: "must_find", expectations: [seed] };
  return stringifyExpectedOutput(next);
}

/* ------------------------------------------------------------------ draft */

/** The editable surface of a case. Everything else on the record is read-only. */
export interface CaseDraft {
  name: string;
  diff: string;
  metaTitle: string;
  metaBody: string;
  /** Raw text, not a parsed object — the user may hold it invalid mid-edit. */
  expectedText: string;
}

const BLANK_EXPECTED: EvalExpectedOutput = { kind: "must_find", expectations: [] };

/** Seed the form once, from the fetched record or from nothing (a new case). */
export function draftFromRecord(record: EvalCaseRecord | null): CaseDraft {
  if (!record) {
    return {
      name: "",
      diff: "",
      metaTitle: "",
      metaBody: "",
      expectedText: stringifyExpectedOutput(BLANK_EXPECTED),
    };
  }
  return {
    name: record.name,
    diff: record.input_diff,
    metaTitle: record.input_meta?.title ?? "",
    metaBody: record.input_meta?.body ?? "",
    expectedText: stringifyExpectedOutput(record.expected_output),
  };
}

/**
 * Draft -> wire body. `expected_output` is the PARSED value, never the raw
 * text: Save is disabled while the text is invalid (AC-14), so a caller that
 * reaches here always has a parsed object to hand.
 *
 * `input_meta` is rebuilt from the record so provenance the editor does not
 * expose (`number`, `author`, `base`, `branch`) survives a save — the case is
 * pinned input, and silently dropping half of it would change what a rerun
 * compares against (§5.2).
 */
/**
 * Seed the editor from a server-composed, UNSAVED draft (C24) — the "Turn into
 * eval case" path. Identical in shape to `draftFromRecord`; the difference is
 * that nothing has been persisted yet, so Save creates rather than updates.
 */
export function draftFromCaseDraft(draft: EvalCaseDraft): CaseDraft {
  return {
    name: draft.name,
    diff: draft.input_diff,
    metaTitle: draft.input_meta?.title ?? "",
    metaBody: draft.input_meta?.body ?? "",
    expectedText: stringifyExpectedOutput(draft.expected_output),
  };
}

/**
 * The body for `POST /findings/:id/eval-case` (C21) — what the user actually
 * approved in the editor. `owner_id` and `source_finding_id` are deliberately
 * absent: the server mints provenance from the finding's own review, so the
 * editor cannot re-own or re-point a case.
 */
export function draftToFindingInput(
  draft: CaseDraft,
  expected: EvalExpectedOutput,
  seed: EvalCaseDraft,
): EvalCaseFromFindingInput {
  return {
    name: draft.name.trim(),
    input_diff: draft.diff,
    input_meta: {
      ...seed.input_meta,
      title: draft.metaTitle.length > 0 ? draft.metaTitle : null,
      body: draft.metaBody.length > 0 ? draft.metaBody : null,
    },
    expected_output: expected,
    notes: seed.notes ?? null,
  };
}

export function draftToInput(
  draft: CaseDraft,
  expected: EvalExpectedOutput,
  ownerId: string,
  record: EvalCaseRecord | null,
): EvalCaseInput {
  const meta: EvalPrMeta = {
    ...(record?.input_meta ?? {}),
    title: draft.metaTitle.length > 0 ? draft.metaTitle : null,
    body: draft.metaBody.length > 0 ? draft.metaBody : null,
  };
  return {
    owner_kind: "agent",
    owner_id: ownerId,
    name: draft.name.trim(),
    input_diff: draft.diff,
    input_meta: meta,
    expected_output: expected,
  };
}

/* ------------------------------------------------------------------ errors */

/**
 * AC-12 — read the affected run count out of a 409 `case_has_runs` so the
 * delete confirmation can state the consequence. Returns `null` for any other
 * error, which is the caller's "this was not the guarded-delete path" signal.
 *
 * The count key is read defensively (`run_count` / `runs` / `count`) because
 * the route that produces it is a sibling task; when it is absent we still know
 * at least one run exists, so we never claim "0 recorded runs".
 */
export function readCaseHasRunsCount(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const err = error as { status?: unknown; code?: unknown; details?: unknown };
  if (err.status !== 409 || err.code !== "case_has_runs") return null;
  const details = err.details;
  if (details && typeof details === "object") {
    const bag = details as Record<string, unknown>;
    for (const key of ["run_count", "runs", "count"]) {
      const value = bag[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    }
  }
  return FALLBACK_RUN_COUNT;
}

/**
 * Provenance of a case created from a judged finding.
 *
 *  - `none`   — the case was authored by hand.
 *  - `linked` — we can address the PR: routes are keyed by PR **number** while
 *               every API is keyed by row **uuid**, so the href is built from
 *               `input_meta.number`, never from a uuid.
 *  - `plain`  — the provenance is real but this surface has no repo in scope
 *               (the AgentEditor Evals tab), so the note renders without a link.
 *  - `gone`   — `source_finding_id` points at a row that can no longer be
 *               reached: `findings` rows are deleted with run history and the
 *               column deliberately has no FK (§3), and a case whose pinned
 *               `input_meta` carries no PR number has nothing left to open.
 */
export type SourceFindingState =
  | { kind: "none" }
  | { kind: "gone" }
  | { kind: "plain" }
  | { kind: "linked"; href: string };

export function sourceFindingState(
  record: EvalCaseRecord | null,
  repoId: string | null | undefined,
): SourceFindingState {
  const findingId = record?.source_finding_id;
  if (!findingId) return { kind: "none" };
  const number = record?.input_meta?.number;
  if (number == null) return { kind: "gone" };
  if (!repoId) return { kind: "plain" };
  const params = new URLSearchParams({ tab: "findings", finding: findingId });
  return {
    kind: "linked",
    href: `/repos/${encodeURIComponent(repoId)}/pulls/${number}?${params.toString()}`,
  };
}
