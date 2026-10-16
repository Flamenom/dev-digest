import { z } from 'zod';
import { Finding, Severity, FindingCategory } from './findings.js';
import { EvalCase, EvalOwnerKind, Agent, Provider } from './knowledge.js';
import { EvalRunRecord, EvalDashboard } from './eval-ci.js';

/**
 * L06 — Eval Pipeline (spec: `specs/06-eval-pipeline.md` §2.2, C1–C23).
 *
 * ADDITIVE ONLY. The frozen eval contracts (`EvalCase`, `EvalRun`,
 * `EvalPerTrace`, `EvalOwnerKind` in `contracts/knowledge.ts`; `EvalCaseInput`,
 * `EvalRunRecord`, `EvalRunResult`, `EvalTrendPoint`, `EvalDashboard` in
 * `contracts/eval-ci.ts`) are NEVER edited — per root `CLAUDE.md`,
 * `@devdigest/shared` is vendored (twice) and existing contract files are
 * extended from a NEW file. `EvalCaseRecord` (C6) and `EvalCaseRunRecord` (C8)
 * therefore use `.extend()` on the frozen schemas (the `04-intent-layer.md`
 * precedent) rather than adding a field to them.
 *
 * Optionality convention (root `INSIGHTS.md`): a genuinely OPTIONAL field uses
 * `.nullish()` — a `.nullable()` field is *required-but-null*, so the key must
 * be present and every fixture that builds the object breaks. `.nullable()` is
 * used here ONLY where the spec table itself writes `|null`: a value the server
 * ALWAYS emits and whose null is a meaningful, computed answer (a metric with a
 * zero denominator, a batch that has no comparable predecessor). This mirrors
 * the frozen `EvalRunRecord.recall/precision/citation_accuracy`.
 *
 * ---------------------------------------------------------------------------
 * The "vacuous-perfect" convention (spec §4.6) — read this before consuming a
 * metric.
 * ---------------------------------------------------------------------------
 * Every metric is a micro-average whose denominator can legitimately be zero:
 *
 *   recall            = Σ must_find_matched / Σ must_find_total
 *   precision         = 1 − (Σ noise_findings / Σ findings_total)
 *   citation_accuracy = Σ grounding_kept   / Σ grounding_total
 *
 * A zero denominator yields `null` — NEVER `NaN`, and never a silently-invented
 * number. The honest nulls, together with every denominator, live on
 * `EvalBatchRecord` (C10) and `EvalCompare.deltas` (C19), and those are what the
 * UI renders. A `null` metric must display as `—`, never as a score (AC-21).
 *
 * The frozen `EvalRun` (knowledge.ts) types its metrics `z.number().min(0).max(1)`
 * and cannot express that. When a batch is projected onto `EvalRun` /
 * `EvalDashboard.current`, a null metric is coerced to `1` — "vacuously perfect":
 * zero opportunities to be wrong. `traces_passed = cases_passed`,
 * `traces_total = cases_total`. A coerced `1` is a contract-compatibility filler
 * and MUST NOT be surfaced as a measured score.
 *
 * Two consequences of that coercion, decided in the plan's §Concerns and pinned
 * here so they are discoverable from the contract itself:
 *
 *  - §Concerns C3 — `EvalDashboard.delta.*` is frozen as non-nullable
 *    `z.number()`, and §4.6 makes every metric nullable. The producer therefore
 *    computes `delta[m] = (head[m] ?? 1) − (base[m] ?? 1)`, and `0` when the
 *    window holds fewer than two complete batches. Those coerced deltas exist
 *    only to keep the frozen shape honest; the nullable, truthful deltas are
 *    `EvalCompare.deltas` (C19) and `EvalAlertDetail` (C16), which is what the
 *    client reads.
 *  - §Concerns C4 — `EvalTrendPoint` metrics are non-nullable too. A trend point
 *    whose recall, precision or citation_accuracy is `null` is therefore OMITTED
 *    from `EvalDashboard.trend` entirely rather than coerced (§4.6: null metrics
 *    are skipped in the sparkline). `pass_rate = cases_passed / cases_total`, and
 *    `0` when `cases_total` is `0`. Nothing disappears from the UI: the batch
 *    table still lists that batch through `EvalBatchRecord` (C10) with its
 *    honest nulls.
 */

// ===========================================================================
// Expectations — what a case asserts about a diff (D2: one case, one kind)
// ===========================================================================

/**
 * C1 — `must_find`: the agent must report the expectation's location.
 * `must_not_flag`: the agent must NOT comment on it. One case carries exactly
 * one kind (D2).
 */
export const EvalExpectationKind = z.enum(['must_find', 'must_not_flag']);
export type EvalExpectationKind = z.infer<typeof EvalExpectationKind>;

/**
 * C2 — one asserted location. `[start_line, end_line]` is a CLOSED, INCLUSIVE
 * interval of NEW-side line numbers (the space the grounding gate indexes); a
 * missing `end_line` defaults to `start_line` (§4.2).
 *
 * `title` / `severity` / `category` are ADVISORY DISPLAY METADATA ONLY — they
 * are shown in the case editor and the severity badge, and they take no part in
 * the match rule (§4.3), which is file + range intersection and nothing else.
 */
export const EvalExpectation = z.object({
  file: z.string().min(1),
  start_line: z.number().int(),
  end_line: z.number().int().nullish(),
  title: z.string().nullish(),
  severity: Severity.nullish(),
  category: FindingCategory.nullish(),
});
export type EvalExpectation = z.infer<typeof EvalExpectation>;

/** C3 — the `eval_cases.expected_output` jsonb wrapper (D2). */
export const EvalExpectedOutput = z.object({
  kind: EvalExpectationKind,
  expectations: z.array(EvalExpectation),
});
export type EvalExpectedOutput = z.infer<typeof EvalExpectedOutput>;

/**
 * C4 — the `eval_cases.input_meta` jsonb: the synthetic PR's metadata. Only
 * `title` and `body` reach the model (as `task` framing and `prDescription`);
 * the rest is display (§5.2).
 */
export const EvalPrMeta = z.object({
  title: z.string().nullish(),
  body: z.string().nullish(),
  number: z.number().int().nullish(),
  author: z.string().nullish(),
  base: z.string().nullish(),
  branch: z.string().nullish(),
});
export type EvalPrMeta = z.infer<typeof EvalPrMeta>;

// ===========================================================================
// Cases — server → client records
// ===========================================================================

/** C5 — the case list's "last run" strip. `pass === null` = errored / not run. */
export const EvalCaseLastRun = z.object({
  run_id: z.string(),
  ran_at: z.string(),
  pass: z.boolean().nullable(),
  expected_count: z.number().int(),
  produced_count: z.number().int(),
  duration_ms: z.number().int().nullish(),
  cost_usd: z.number().nullish(),
});
export type EvalCaseLastRun = z.infer<typeof EvalCaseLastRun>;

/**
 * C6 — the case as the API returns it. EXTENDS the frozen `EvalCase`, narrowing
 * its `expected_output` / `input_meta` `z.unknown()` blobs to the concrete
 * shapes above. `source_finding_id` is a SOFT provenance pointer with no FK
 * (§3) — a dangling value renders as "source finding no longer exists".
 * `diff_warnings` carries the case-editor validation strings (AC-13), e.g. a
 * `must_find` expectation whose range misses every hunk of its own diff.
 */
export const EvalCaseRecord = EvalCase.extend({
  expected_output: EvalExpectedOutput,
  input_meta: EvalPrMeta,
  source_finding_id: z.string().nullish(),
  last_run: EvalCaseLastRun.nullish(),
  diff_warnings: z.array(z.string()),
});
export type EvalCaseRecord = z.infer<typeof EvalCaseRecord>;

// ===========================================================================
// Runs — one execution of one case
// ===========================================================================

/**
 * C7 — the `eval_runs.actual_output` blob. `grounding_total = grounding_kept +
 * grounding_dropped.length` is exactly the PRE-GATE finding count, which holds
 * only because the eval runner never passes `intent` (§4.5) — with `intent` the
 * scope filter drops findings AFTER grounding and the partition breaks.
 * `case_fingerprint` (§4.7) is what makes two batches comparable without an
 * extra column.
 */
export const EvalActualOutput = z.object({
  findings: z.array(Finding),
  pre_gate_count: z.number().int(),
  grounding_kept: z.number().int(),
  grounding_total: z.number().int(),
  grounding_dropped: z.array(z.object({ title: z.string(), reason: z.string() })),
  matched_expectations: z.number().int(),
  noise_findings: z.number().int(),
  case_fingerprint: z.string(),
  expectation_kind: EvalExpectationKind,
  error: z.string().nullish(),
});
export type EvalActualOutput = z.infer<typeof EvalActualOutput>;

/**
 * C8 — a per-case run row. EXTENDS the frozen `EvalRunRecord` with the three
 * columns migration 0018 adds; all three are nullish because rows written
 * before 0018 still read (§3).
 */
export const EvalCaseRunRecord = EvalRunRecord.extend({
  batch_id: z.string().nullish(),
  agent_version: z.number().int().nullish(),
  error: z.string().nullish(),
});
export type EvalCaseRunRecord = z.infer<typeof EvalCaseRunRecord>;

// ===========================================================================
// Batches — derived by grouping `eval_runs` on `batch_id` (no header table)
// ===========================================================================

/**
 * C9 — DERIVED ON READ, never stored (§5.3): `running` while ≥1 row is still
 * pending inside the stale window, `failed` when finished and every row
 * errored, else `complete`.
 */
export const EvalBatchStatus = z.enum(['running', 'complete', 'failed']);
export type EvalBatchStatus = z.infer<typeof EvalBatchStatus>;

/**
 * C10 — one batch, aggregated on read. The three metrics are `|null` on a zero
 * denominator (§4.6) and every denominator ships alongside them, so the UI can
 * render `—` instead of a vacuous 1.0. This is the shape the metric tiles read.
 */
export const EvalBatchRecord = z.object({
  batch_id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  agent_version: z.number().int().nullish(),
  ran_at: z.string(),
  status: EvalBatchStatus,
  recall: z.number().nullable(),
  precision: z.number().nullable(),
  citation_accuracy: z.number().nullable(),
  cases_total: z.number().int(),
  cases_passed: z.number().int(),
  cases_failed: z.number().int(),
  cases_errored: z.number().int(),
  must_find_total: z.number().int(),
  must_find_matched: z.number().int(),
  must_not_flag_total: z.number().int(),
  noise_findings: z.number().int(),
  findings_total: z.number().int(),
  grounding_kept: z.number().int(),
  grounding_total: z.number().int(),
  duration_ms: z.number().int(),
  cost_usd: z.number().nullable(),
});
export type EvalBatchRecord = z.infer<typeof EvalBatchRecord>;

/** C11 — `POST /agents/:id/eval-runs` body. Omit `case_ids` ⇒ all cases. */
export const EvalBatchRunInput = z.object({
  case_ids: z.array(z.string()).nullish(),
});
export type EvalBatchRunInput = z.infer<typeof EvalBatchRunInput>;

/**
 * C12 — the 202 body. `cases_total` is knowable up front because one pending
 * `eval_runs` row per case is inserted BEFORE the response (§5.3).
 */
export const EvalBatchStarted = z.object({
  batch_id: z.string(),
  agent_id: z.string(),
  agent_version: z.number().int(),
  cases_total: z.number().int(),
});
export type EvalBatchStarted = z.infer<typeof EvalBatchStarted>;

// ===========================================================================
// Dashboards
// ===========================================================================

/**
 * C13 — one agent row-card on `/evals`. `last_batch` is the LATEST COMPLETE
 * batch only, not a rolling window (§8.2); `sparkline` is the recall of the
 * last `SPARKLINE_BATCHES` complete batches, oldest→newest, null metrics
 * skipped.
 */
export const EvalAgentSummary = z.object({
  agent_id: z.string(),
  name: z.string(),
  model: z.string(),
  version: z.number().int(),
  enabled: z.boolean(),
  cases_total: z.number().int(),
  last_batch: EvalBatchRecord.nullable(),
  sparkline: z.array(z.number()),
});
export type EvalAgentSummary = z.infer<typeof EvalAgentSummary>;

/** C14 — `GET /evals/dashboard` (screen B). */
export const EvalDashboardOverview = z.object({
  agents: z.array(EvalAgentSummary),
  recent_batches: z.array(EvalBatchRecord),
});
export type EvalDashboardOverview = z.infer<typeof EvalDashboardOverview>;

// ===========================================================================
// Alerts — deterministic, structured, localised by the client
// ===========================================================================

/** C15 — one significant metric move. `delta_pts` is rounded HALF AWAY FROM ZERO (§8.4). */
export const EvalAlertSignal = z.object({
  metric: z.enum(['recall', 'precision', 'citation_accuracy']),
  direction: z.enum(['up', 'down']),
  delta_pts: z.number().int(),
});
export type EvalAlertSignal = z.infer<typeof EvalAlertSignal>;

/**
 * C16 — the alert banner, STRUCTURED so the client renders it through next-intl
 * instead of displaying a server-built English sentence. The frozen
 * `EvalDashboard.alert` is `z.string().nullable()`; the server fills it with a
 * plain-English fallback to keep that contract honest, and the client ignores
 * it in favour of this (§2.2, §8.4).
 */
export const EvalAlertDetail = z.object({
  tone: z.enum(['warn', 'info']),
  primary: EvalAlertSignal,
  others: z.array(EvalAlertSignal),
  new_false_positive: z.boolean(),
  head_version: z.number().int().nullish(),
});
export type EvalAlertDetail = z.infer<typeof EvalAlertDetail>;

/**
 * C17 — `GET /agents/:id/eval-dashboard` (screen C). `window_days` is `null`
 * for "all time". `dashboard` is the frozen `EvalDashboard`, so its `current`
 * and `delta` carry the vacuous-perfect coercions described in this file's
 * header; `batches` and `alert` carry the honest values the UI renders.
 */
export const EvalAgentDashboard = z.object({
  agent: z.object({
    id: z.string(),
    name: z.string(),
    model: z.string(),
    version: z.number().int(),
    provider: Provider,
  }),
  window_days: z.number().int().nullable(),
  dashboard: EvalDashboard,
  batches: z.array(EvalBatchRecord),
  alert: EvalAlertDetail.nullable(),
});
export type EvalAgentDashboard = z.infer<typeof EvalAgentDashboard>;

// ===========================================================================
// Compare + promote
// ===========================================================================

/** C18 — one line of the system-prompt diff; the client owns the rendering. */
export const EvalPromptDiffLine = z.object({
  kind: z.enum(['context', 'added', 'removed']),
  text: z.string(),
});
export type EvalPromptDiffLine = z.infer<typeof EvalPromptDiffLine>;

/**
 * C19 — `GET /evals/compare?base=&head=` (design D). A delta is `null` when
 * either side is `null` and the card renders `—`. `comparable` is `false` when
 * the two batches' multisets of `(case_id, case_fingerprint)` differ, and
 * `changed_case_ids` names them (§5.2) — the deltas are then not like-for-like.
 * `prompt_diff_available` is `false` when either batch has a null
 * `agent_version` (a pre-0018 row) or its snapshot is missing.
 */
export const EvalCompare = z.object({
  base: EvalBatchRecord,
  head: EvalBatchRecord,
  deltas: z.object({
    recall: z.number().nullable(),
    precision: z.number().nullable(),
    citation_accuracy: z.number().nullable(),
    cost_usd: z.number().nullable(),
  }),
  comparable: z.boolean(),
  changed_case_ids: z.array(z.string()),
  prompt_diff: z.array(EvalPromptDiffLine),
  prompt_diff_available: z.boolean(),
  promote_target_version: z.number().int().nullable(),
});
export type EvalCompare = z.infer<typeof EvalCompare>;

/**
 * C20 — `POST /agents/:id/versions/:version/promote`. Version history is
 * append-only: promoting v7 at v9 creates v10 with v7's config (§9.2). When the
 * target config equals the live config nothing is created and `changed` is
 * `false` — `new_version` then equals the unchanged current version. Promoting
 * never re-runs evals.
 */
export const EvalPromoteResult = z.object({
  agent: Agent,
  promoted_from_version: z.number().int(),
  new_version: z.number().int(),
  changed: z.boolean(),
});
export type EvalPromoteResult = z.infer<typeof EvalPromoteResult>;

// ===========================================================================
// One-click creation from a finding + run-all
// ===========================================================================

/**
 * C21 — `POST /findings/:id/eval-case`; omit every field to persist the draft
 * the server composes from the finding verbatim (§7).
 *
 * The editable fields exist because the case editor opens on the PR page BEFORE
 * anything is written: the user reviews (and may correct) the composed diff and
 * expectations, and Save posts what they actually approved. Provenance is never
 * settable from here — `owner_id` and `source_finding_id` are always minted from
 * the finding's own review, so a body cannot re-own or re-point a case.
 */
export const EvalCaseFromFindingInput = z.object({
  name: z.string().nullish(),
  input_diff: z.string().nullish(),
  input_meta: z.unknown().nullish(),
  expected_output: z.unknown().nullish(),
  notes: z.string().nullish(),
});
export type EvalCaseFromFindingInput = z.infer<typeof EvalCaseFromFindingInput>;

/**
 * C25 — `POST /agents/:id/eval-cases/run-draft`. Execute a case that has NOT
 * been saved and persist NOTHING.
 *
 * The case editor's "Run case" on an unsaved draft: the reviewer sees what the
 * agent actually produces before committing the case to the agent's set. It is
 * the same engine call and the same scoring as a saved run, so a draft run
 * predicts the saved case's result rather than approximating it — but it writes
 * no `eval_runs` row, so it never moves a metric or appears in a batch.
 */
export const EvalDraftRunInput = z.object({
  name: z.string().min(1),
  input_diff: z.string(),
  input_meta: EvalPrMeta.nullish(),
  expected_output: EvalExpectedOutput,
});
export type EvalDraftRunInput = z.infer<typeof EvalDraftRunInput>;

/**
 * C24 — `GET /findings/:id/eval-case-draft`. The composed-but-UNSAVED case the
 * editor opens with.
 *
 * Same guards as R1 (404 foreign finding, 409 not-judged / no-agent / no-patch)
 * and the same composition code path, so what the modal shows is exactly what a
 * bare Save would persist. Nothing is written: the button reaches its created
 * state only once the user saves.
 */
export const EvalCaseDraft = z.object({
  owner_kind: EvalOwnerKind,
  owner_id: z.string(),
  name: z.string(),
  input_diff: z.string(),
  input_meta: EvalPrMeta,
  expected_output: EvalExpectedOutput,
  notes: z.string().nullish(),
  source_finding_id: z.string(),
});
export type EvalCaseDraft = z.infer<typeof EvalCaseDraft>;

/**
 * C22 — `GET /pulls/:id/eval-cases`. The PR page joins this by `finding_id`
 * client-side to render the "Eval case ✓" state, so the frozen
 * `ReviewRecord.findings: Finding[]` contract stays untouched (§7).
 */
export const EvalCaseLink = z.object({
  finding_id: z.string(),
  case_id: z.string(),
  case_name: z.string(),
});
export type EvalCaseLink = z.infer<typeof EvalCaseLink>;

/** C23 — `POST /evals/run-all`: one batch per ELIGIBLE agent, the rest explained. */
export const EvalRunAllResult = z.object({
  started: z.array(EvalBatchStarted),
  skipped: z.array(
    z.object({
      agent_id: z.string(),
      agent_name: z.string(),
      reason: z.enum(['no_cases', 'already_running', 'disabled']),
    }),
  ),
});
export type EvalRunAllResult = z.infer<typeof EvalRunAllResult>;
