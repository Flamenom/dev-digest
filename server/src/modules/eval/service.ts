/**
 * L06 Eval Pipeline — case CRUD (R2–R8) and one-click creation from a judged
 * finding (R1, spec §7).
 *
 * ---------------------------------------------------------------------------
 * APPLICATION ring. Orchestration only — no SQL, no Fastify, no `Container`.
 * ---------------------------------------------------------------------------
 * Dependencies arrive as an EXPLICIT deps object (onion §7, the `modules/blast`
 * / `modules/smart-diff` precedent), built once in the composition root. The
 * ports below are STRUCTURAL projections shaped by this consumer, so nothing
 * here imports a sibling module's folder (onion §9) and no `$inferSelect` row
 * type crosses a signature (onion §5). The concrete `ReviewRepository`,
 * `AgentsRepository`, `EvalRepository` and `EvalRunner` satisfy them as-is.
 *
 * SECURITY — the two barriers that live in this file:
 *   * A01. `reviewRepo.findingContext()` is NOT workspace-scoped: it resolves a
 *     finding by id alone. `createFromFinding` therefore asserts
 *     `pull.workspaceId === workspaceId` itself and answers 404 (never 403) —
 *     a wrong-tenant id must be indistinguishable from a missing one, or the
 *     status code leaks the existence of another workspace's finding.
 *   * A08. No request body is ever spread into a write. Every persisted field
 *     is named explicitly, both on create and on update, so an attacker cannot
 *     smuggle `workspace_id`, `source_finding_id` or `id` through the body.
 *
 * TRUST BOUNDARY. `EvalCaseInput` (frozen, `eval-ci.ts:20-29`) types `owner_id`
 * as a bare `z.string()` and `expected_output` as `z.unknown()`, so parsing the
 * body against it is NOT sufficient (plan §Concerns C5). The second gate is
 * enforced HERE rather than only in the route, so it holds for every caller of
 * the service: `owner_id` must be a uuid, `expected_output` must parse as
 * `EvalExpectedOutput` (C3), and `input_diff` must be non-empty.
 */
import {
  EvalActualOutput,
  EvalExpectedOutput,
  EvalPrMeta,
  FindingCategory,
  Severity,
  type EvalCaseDraft,
  type EvalDraftRunInput,
  type EvalCaseFromFindingInput,
  type EvalCaseInput,
  type EvalCaseLink,
  type EvalCaseRecord,
  type EvalExpectation,
  type EvalOwnerKind,
  type EvalRunResult,
} from '@devdigest/shared';
import { AppError, NotFoundError, ValidationError } from '../../platform/errors.js';
import { nextFreeName, slugifyCaseName } from './naming.js';
import { parseExpectedOutput } from './scoring.js';
import {
  DuplicateSourceFindingError,
  type EvalCaseDeleteResult,
  type EvalCaseDomain,
  type EvalCaseLinkRow,
  type EvalCasePatch,
  type EvalRunDomain,
  type NewEvalCase,
} from './types.js';

// ===========================================================================
// Ports — structural projections of the collaborators (onion §3/§9)
// ===========================================================================

/** The `findings` row, as this service reads it. `FindingRow` satisfies it. */
export interface EvalServiceFinding {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  /** Plain `text` columns — they can hold values outside the enum (§7). */
  severity: string;
  category: string;
  title: string;
  acceptedAt: Date | null;
  dismissedAt: Date | null;
}

/** The `reviews` row. `agentId` is NULLABLE with no FK (`db/schema/reviews.ts:29`). */
export interface EvalServiceReview {
  id: string;
  agentId: string | null;
}

/** The `pull_requests` row — the ONLY place a workspace id is available for a finding. */
export interface EvalServicePull {
  id: string;
  workspaceId: string;
  number: number;
  title: string;
  body: string | null;
  author: string;
  base: string;
  branch: string;
}

/** One `pr_files` row. `patch` is nullable (binary / oversized file). */
export interface EvalServicePrFile {
  path: string;
  patch: string | null;
}

/** The slice of `ReviewRepository` this service uses. */
export interface EvalServiceReviewRepo {
  /**
   * NOT workspace-scoped — resolves by finding id alone. Every caller here
   * asserts the tenant itself; see the A01 note in the file header.
   */
  findingContext(
    findingId: string,
  ): Promise<
    { finding: EvalServiceFinding; review: EvalServiceReview; pull: EvalServicePull } | undefined
  >;
  getPull(workspaceId: string, prId: string): Promise<{ id: string } | undefined>;
  getPrFiles(prId: string): Promise<EvalServicePrFile[]>;
}

/** The slice of `AgentsRepository` this service uses — existence + tenancy of an owner. */
export interface EvalServiceAgentsRepo {
  getById(workspaceId: string, id: string): Promise<{ id: string } | undefined>;
}

/** The slice of `EvalRunner` this service uses (R8). */
export interface EvalServiceRunner {
  runSingleCase(workspaceId: string, agentId: string, caseId: string): Promise<EvalRunResult>;
  runDraftCase(
    workspaceId: string,
    agentId: string,
    draft: { name: string; inputDiff: string; inputMeta: unknown; expectedOutput: unknown },
  ): Promise<EvalRunResult>;
}

/** The slice of `EvalRepository` this service uses. The real class satisfies it. */
export interface EvalServiceRepo {
  listCasesForOwner(workspaceId: string, ownerId: string): Promise<EvalCaseDomain[]>;
  getCase(workspaceId: string, caseId: string): Promise<EvalCaseDomain | undefined>;
  insertCase(input: NewEvalCase): Promise<EvalCaseDomain>;
  updateCase(
    workspaceId: string,
    caseId: string,
    patch: EvalCasePatch,
  ): Promise<EvalCaseDomain | undefined>;
  deleteCase(
    workspaceId: string,
    caseId: string,
    opts: { force?: boolean },
  ): Promise<EvalCaseDeleteResult>;
  findCaseBySourceFinding(
    workspaceId: string,
    findingId: string,
  ): Promise<EvalCaseDomain | undefined>;
  takenNamesForOwner(workspaceId: string, ownerId: string): Promise<string[]>;
  caseLinksForPull(workspaceId: string, prId: string): Promise<EvalCaseLinkRow[]>;
  latestRunPerCase(workspaceId: string, ownerId: string): Promise<Map<string, EvalRunDomain>>;
}

/** Explicit deps object — built in the composition root, never a `Container`. */
export interface EvalServiceDeps {
  evalRepo: EvalServiceRepo;
  reviewRepo: EvalServiceReviewRepo;
  agentsRepo: EvalServiceAgentsRepo;
  runner: EvalServiceRunner;
}

/** R1's result. The route maps `created` to 201 vs 200 (AC-9 idempotency). */
export interface EvalCaseCreation {
  /** `false` when an existing case was returned instead of a new one. */
  created: boolean;
  record: EvalCaseRecord;
}

// ===========================================================================
// Pure local helpers
// ===========================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A case whose stored `expected_output` does not parse still has to satisfy the
 * non-nullable `EvalCaseRecord.expected_output` (C6). It degrades to an empty
 * `must_find` set and the reason is surfaced in `diff_warnings` — never a 500,
 * because the blob is hand-editable JSON (AC-14 is the editor's own badge).
 */
const UNPARSEABLE_EXPECTED_OUTPUT: EvalExpectedOutput = { kind: 'must_find', expectations: [] };

/** `@@ -a,b +c,d @@` — only the NEW-side pair matters (the space grounding indexes, §4.2). */
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

interface DiffHunkRange {
  file: string;
  start: number;
  end: number;
}

/**
 * Scan a stored `input_diff` for its `+++ b/<path>` files and their new-side
 * hunk intervals. Deliberately a ~20-line regex scan rather than
 * `parseUnifiedDiff`: importing `adapters/git/diff-parser.js` here would trip
 * `no-concrete-adapter-outside-root` a second time, and the only fact needed is
 * "which line ranges does this diff cover", not a parsed diff model.
 */
function scanHunks(diff: string): DiffHunkRange[] {
  const hunks: DiffHunkRange[] = [];
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      file = path.startsWith('b/') ? path.slice(2) : path;
      continue;
    }
    const m = HUNK_HEADER_RE.exec(line);
    if (!m || file === '') continue;
    const start = Number(m[1]);
    // An absent count means 1 line; a `+c,0` hunk is a pure deletion, which
    // still anchors at `c` — clamp so the interval is never inverted.
    const count = m[2] === undefined ? 1 : Number(m[2]);
    hunks.push({ file, start, end: start + Math.max(count, 1) - 1 });
  }
  return hunks;
}

/**
 * AC-13's rule, evaluated over the PERSISTED case: every `must_find`
 * expectation whose range misses every hunk of its own file is a warning,
 * because the grounding gate would drop the correct answer and that case's
 * recall could never reach 1.0 (§11 invariant 3).
 *
 * The case editor re-computes the same rule live on unsaved text (T22,
 * `EvalCaseEditorModal/helpers.ts`) — the browser cannot call this. These
 * strings are the server's honest description of what is stored; the client
 * renders its own localized copy.
 */
function diffWarnings(diff: string, expected: EvalExpectedOutput): string[] {
  if (expected.kind !== 'must_find' || expected.expectations.length === 0) return [];
  const hunks = scanHunks(diff);
  const warnings: string[] = [];
  expected.expectations.forEach((exp, i) => {
    const lo = Math.min(exp.start_line, exp.end_line ?? exp.start_line);
    const hi = Math.max(exp.start_line, exp.end_line ?? exp.start_line);
    const hit = hunks.some((h) => h.file === exp.file && lo <= h.end && h.start <= hi);
    if (!hit) {
      warnings.push(
        `Expectation ${i + 1} (${exp.file}:${lo}-${hi}) does not intersect any hunk of this case's diff.`,
      );
    }
  });
  return warnings;
}

/**
 * The single-file unified diff a case pins as its input, rebuilt EXACTLY as
 * `diffFromPrFiles` does (`modules/reviews/diff-loader.ts:33-44`) so a case
 * diff and a real review diff parse identically.
 *
 * The WHOLE file patch, never the finding's hunk (§7): trimming a patch to the
 * finding's line range invalidates the `@@ -a,b +c,d @@` headers, and the
 * grounding gate indexes new-side line numbers from those headers — a trimmed
 * diff would make the correct answer ungroundable.
 */
function singleFileDiff(path: string, patch: string): string {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, patch].join('\n');
}

/** Advisory enum metadata, kept only when it validates (§7, §4.3). */
function advisoryEnums(finding: EvalServiceFinding): {
  severity?: EvalExpectation['severity'];
  category?: EvalExpectation['category'];
} {
  const severity = Severity.safeParse(finding.severity);
  const category = FindingCategory.safeParse(finding.category);
  return {
    ...(severity.success ? { severity: severity.data } : {}),
    ...(category.success ? { category: category.data } : {}),
  };
}

// ===========================================================================
// Service
// ===========================================================================

export class EvalService {
  constructor(private deps: EvalServiceDeps) {}

  // -------------------------------------------------------------------------
  // R1 — one-click creation from a judged finding (spec §7)
  // -------------------------------------------------------------------------

  /**
   * Turn a judged finding into an eval case.
   *
   * Order of checks is deliberate:
   *  1. resolve the finding, then ASSERT THE TENANT (A01) — everything after
   *     this line has been proven to belong to `workspaceId`;
   *  2. idempotency BEFORE the 409s: a finding that already produced a case
   *     answers 200 with that case even if it was un-judged afterwards (AC-9);
   *  3. 409 `finding_not_judged` → 409 `finding_has_no_agent` → 409
   *     `no_patch_for_file`, cheapest first, and none of them writes a row.
   */
  async createFromFinding(
    workspaceId: string,
    findingId: string,
    input?: EvalCaseFromFindingInput | null,
  ): Promise<EvalCaseCreation> {
    const ctx = await this.findingContextOr404(workspaceId, findingId);

    const existing = await this.deps.evalRepo.findCaseBySourceFinding(workspaceId, findingId);
    if (existing) return { created: false, record: await this.toRecord(workspaceId, existing) };

    const values = await this.composeFromFinding(workspaceId, ctx, input);

    try {
      const created = await this.deps.evalRepo.insertCase(values);
      return { created: true, record: await this.toRecord(workspaceId, created) };
    } catch (err) {
      // Race-safe second guard: two concurrent clicks both pass the read above,
      // and `eval_cases_source_finding_uq` rejects the loser. That is still the
      // idempotent path (AC-9), not an error.
      if (err instanceof DuplicateSourceFindingError) {
        const raced = await this.deps.evalRepo.findCaseBySourceFinding(workspaceId, findingId);
        if (raced) return { created: false, record: await this.toRecord(workspaceId, raced) };
      }
      throw err;
    }
  }

  /**
   * R1b — the composed-but-UNSAVED case a finding would produce (C24).
   *
   * The PR page opens the editor on this BEFORE anything is written, so the
   * user reviews the reconstructed diff and expectations and only then saves.
   * It runs the same guards and the same composition as `createFromFinding`
   * (one code path, no second definition of what a case from a finding IS), so
   * a bare Save persists exactly what was on screen.
   */
  async draftFromFinding(workspaceId: string, findingId: string): Promise<EvalCaseDraft> {
    const ctx = await this.findingContextOr404(workspaceId, findingId);
    const values = await this.composeFromFinding(workspaceId, ctx, null);
    return {
      owner_kind: values.ownerKind,
      owner_id: values.ownerId,
      name: values.name,
      input_diff: values.inputDiff,
      input_meta: EvalPrMeta.parse(values.inputMeta),
      expected_output: values.expectedOutput as EvalExpectedOutput,
      notes: values.notes ?? null,
      source_finding_id: findingId,
    };
  }

  /**
   * Resolve a finding and ASSERT THE TENANT (A01) — `findingContext` is not
   * workspace-scoped, so this is the access-control barrier for both R1 and R1b.
   */
  private async findingContextOr404(workspaceId: string, findingId: string) {
    const ctx = await this.deps.reviewRepo.findingContext(findingId);
    // 404 for "no such finding" AND for another workspace's finding — the two
    // must be indistinguishable, so never 403 (A01).
    if (!ctx || ctx.pull.workspaceId !== workspaceId) {
      throw new NotFoundError('Finding not found');
    }
    return ctx;
  }

  /**
   * Compose the row a judged finding turns into — the §7 rules, and nothing
   * that writes. Shared by R1 (persist) and R1b (preview), which is what keeps
   * the modal's contents and the saved row from ever drifting apart.
   *
   * `input` may carry the user's edits from the case editor. Provenance is not
   * among the editable fields: `ownerId` and `sourceFindingId` are always minted
   * from the finding's own review, so a body cannot re-own or re-point a case.
   */
  private async composeFromFinding(
    workspaceId: string,
    ctx: Awaited<ReturnType<EvalServiceReviewRepo['findingContext']>> & object,
    input?: EvalCaseFromFindingInput | null,
  ): Promise<NewEvalCase> {
    const { finding, review, pull } = ctx;

    if (finding.acceptedAt === null && finding.dismissedAt === null) {
      throw new AppError(
        'finding_not_judged',
        'Accept or dismiss this finding before turning it into an eval case',
        409,
        { finding_id: finding.id },
      );
    }
    // `reviews.agent_id` is nullable with no FK — this path is real, not
    // theoretical (a summary written without an agent hits it).
    const ownerId = review.agentId;
    if (!ownerId) {
      throw new AppError(
        'finding_has_no_agent',
        'The review that produced this finding has no agent, so the case would have no owner',
        409,
        { finding_id: finding.id, review_id: review.id },
      );
    }

    const prFile = (await this.deps.reviewRepo.getPrFiles(pull.id)).find(
      (f) => f.path === finding.file,
    );
    if (!prFile || prFile.patch === null) {
      throw new AppError(
        'no_patch_for_file',
        'No stored patch for this file, so the case would have an empty diff',
        409,
        { finding_id: finding.id, file: finding.file },
      );
    }

    const expectedOutput: EvalExpectedOutput =
      finding.acceptedAt !== null
        ? {
            kind: 'must_find',
            expectations: [
              {
                file: finding.file,
                start_line: finding.startLine,
                end_line: finding.endLine,
                title: finding.title,
                ...advisoryEnums(finding),
              },
            ],
          }
        : {
            // What was dismissed is a LOCATION, not a wording — deliberately no
            // title / severity / category here (§7).
            kind: 'must_not_flag',
            expectations: [
              { file: finding.file, start_line: finding.startLine, end_line: finding.endLine },
            ],
          };

    const taken = await this.deps.evalRepo.takenNamesForOwner(workspaceId, ownerId);
    const requested = input?.name?.trim();
    const name = nextFreeName(slugifyCaseName(requested || finding.title), taken);

    // The editor's version of each field wins when it is present; every one of
    // them goes through the same validator R4/R6 use, so an edited draft cannot
    // reach the DB in a shape a hand-written body could not.
    return {
      workspaceId,
      ownerKind: 'agent',
      ownerId,
      name,
      inputDiff:
        input?.input_diff != null
          ? this.requireInputDiff(input.input_diff)
          : singleFileDiff(finding.file, prFile.patch),
      inputMeta:
        input?.input_meta != null
          ? this.parseMeta(input.input_meta)
          : {
              title: pull.title,
              body: pull.body,
              number: pull.number,
              author: pull.author,
              base: pull.base,
              branch: pull.branch,
            },
      expectedOutput:
        input?.expected_output != null
          ? this.requireExpectedOutput(input.expected_output)
          : expectedOutput,
      notes:
        input?.notes != null
          ? input.notes
          : `Created from finding ${finding.id} on PR #${pull.number}`,
      sourceFindingId: finding.id,
    };
  }

  // -------------------------------------------------------------------------
  // R2/R3/R5 — reads
  // -------------------------------------------------------------------------

  /** R2 — which findings of one PR already have a case (C22). 404 for a PR of another workspace. */
  async linksForPull(workspaceId: string, prId: string): Promise<EvalCaseLink[]> {
    const pull = await this.deps.reviewRepo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');
    const rows = await this.deps.evalRepo.caseLinksForPull(workspaceId, prId);
    return rows.map((r) => ({
      finding_id: r.findingId,
      case_id: r.caseId,
      case_name: r.caseName,
    }));
  }

  /** R3 — every case of one agent, with its last run. 404 for a missing / foreign agent. */
  async listForAgent(workspaceId: string, agentId: string): Promise<EvalCaseRecord[]> {
    await this.requireAgent(workspaceId, agentId);
    const [cases, lastRuns] = await Promise.all([
      this.deps.evalRepo.listCasesForOwner(workspaceId, agentId),
      this.deps.evalRepo.latestRunPerCase(workspaceId, agentId),
    ]);
    return cases.map((c) => this.project(c, lastRuns.get(c.id)));
  }

  /** R5 — one case. 404 for a missing case AND for another workspace's case (never 403). */
  async getCase(workspaceId: string, caseId: string): Promise<EvalCaseRecord> {
    return this.toRecord(workspaceId, await this.requireCase(workspaceId, caseId));
  }

  // -------------------------------------------------------------------------
  // R4/R6/R7 — writes
  // -------------------------------------------------------------------------

  /**
   * R4 — create a case by hand.
   *
   * `EvalCaseInput` is not a sufficient trust boundary on its own (C5), so
   * `owner_id`, `expected_output` and `input_diff` are re-validated here. Every
   * column is named explicitly: the body is never spread (A08), which is what
   * keeps `workspace_id` and `source_finding_id` out of the caller's reach.
   */
  async createCase(workspaceId: string, input: EvalCaseInput): Promise<EvalCaseRecord> {
    const ownerId = this.requireOwnerId(input.owner_id);
    const expectedOutput = this.requireExpectedOutput(input.expected_output);
    const inputDiff = this.requireInputDiff(input.input_diff);
    const name = input.name.trim();
    if (name === '') throw new ValidationError('name must not be empty');

    const ownerKind: EvalOwnerKind = input.owner_kind;
    // Only agent owners are verifiable from here; a skill-owned case is left to
    // the skills slice. A missing agent is 404 `owner`, never 403.
    if (ownerKind === 'agent') await this.requireAgent(workspaceId, ownerId);

    const created = await this.deps.evalRepo.insertCase({
      workspaceId,
      ownerKind,
      ownerId,
      name,
      inputDiff,
      inputFiles: input.input_files ?? null,
      inputMeta: this.parseMeta(input.input_meta),
      expectedOutput,
      notes: input.notes ?? null,
      // NOT settable from a body: provenance is minted by `createFromFinding`.
      sourceFindingId: null,
    });
    return this.toRecord(workspaceId, created);
  }

  /**
   * R6 — patch a case. Only the keys actually present are written, so a partial
   * body never blanks a column it did not mention.
   *
   * `owner_kind` / `owner_id` are deliberately NOT patchable: moving a case
   * between owners would silently rewrite the meaning of every past batch that
   * included it (§5.2), and the repository's patch type does not accept them.
   */
  async updateCase(
    workspaceId: string,
    caseId: string,
    input: Partial<EvalCaseInput>,
  ): Promise<EvalCaseRecord> {
    const patch: EvalCasePatch = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name === '') throw new ValidationError('name must not be empty');
      patch.name = name;
    }
    if (input.input_diff !== undefined) patch.inputDiff = this.requireInputDiff(input.input_diff);
    if (input.input_files !== undefined) patch.inputFiles = input.input_files ?? null;
    if (input.input_meta !== undefined) patch.inputMeta = this.parseMeta(input.input_meta);
    if (input.expected_output !== undefined) {
      patch.expectedOutput = this.requireExpectedOutput(input.expected_output);
    }
    if (input.notes !== undefined) patch.notes = input.notes ?? null;

    const updated = await this.deps.evalRepo.updateCase(workspaceId, caseId, patch);
    if (!updated) throw new NotFoundError('Eval case not found');
    return this.toRecord(workspaceId, updated);
  }

  /**
   * R7 — guarded delete (AC-12). Deleting a case CASCADES its `eval_runs`, i.e.
   * it erases history and shrinks every past batch (§5.2), so a case with runs
   * needs `force`.
   *
   * The 409 carries the affected count under `run_count` — the case-editor
   * modal reads `details.run_count` to render its confirm copy.
   */
  async deleteCase(
    workspaceId: string,
    caseId: string,
    opts: { force?: boolean } = {},
  ): Promise<{ deleted: true }> {
    const result = await this.deps.evalRepo.deleteCase(workspaceId, caseId, {
      force: opts.force === true,
    });
    if (!result.found) throw new NotFoundError('Eval case not found');
    if (!result.deleted) {
      throw new AppError(
        'case_has_runs',
        `This case has ${result.runCount} eval run(s); deleting it would erase them from every past batch`,
        409,
        { case_id: caseId, run_count: result.runCount },
      );
    }
    return { deleted: true };
  }

  // -------------------------------------------------------------------------
  // R8 — run one case
  // -------------------------------------------------------------------------

  /**
   * R8 — run a single case now and wait for it. The case resolves its own
   * agent: `owner_id` IS the agent id for an agent-owned case, so the caller
   * never names an agent and cannot run a case against a foreign one.
   *
   * The runner owns every failure mode from here (409 `batch_already_running`,
   * 422 `empty_diff`, 502 provider) — this method only resolves and delegates.
   */
  async runCase(workspaceId: string, caseId: string): Promise<EvalRunResult> {
    const evalCase = await this.requireCase(workspaceId, caseId);
    if (evalCase.ownerKind !== 'agent') {
      throw new ValidationError('Only agent-owned eval cases can be run');
    }
    return this.deps.runner.runSingleCase(workspaceId, evalCase.ownerId, caseId);
  }

  /**
   * R8b — run a case that has NOT been saved, against an agent, writing nothing.
   *
   * The case editor's "Run case" before Save: the reviewer sees what the agent
   * actually produces and only then commits the case to the agent's set. The
   * body goes through the same validators R4/R6 use, so a draft run cannot
   * exercise a shape a persisted case could not.
   */
  async runDraftCase(
    workspaceId: string,
    agentId: string,
    input: EvalDraftRunInput,
  ): Promise<EvalRunResult> {
    await this.requireAgent(workspaceId, agentId);
    return this.deps.runner.runDraftCase(workspaceId, agentId, {
      name: input.name.trim(),
      inputDiff: this.requireInputDiff(input.input_diff),
      inputMeta: this.parseMeta(input.input_meta),
      expectedOutput: this.requireExpectedOutput(input.expected_output),
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** 404 for a missing case AND for another workspace's case — never 403 (A01). */
  private async requireCase(workspaceId: string, caseId: string): Promise<EvalCaseDomain> {
    const found = await this.deps.evalRepo.getCase(workspaceId, caseId);
    if (!found) throw new NotFoundError('Eval case not found');
    return found;
  }

  /** 404 for a missing agent AND for another workspace's agent — never 403 (A01). */
  private async requireAgent(workspaceId: string, agentId: string): Promise<void> {
    const agent = await this.deps.agentsRepo.getById(workspaceId, agentId);
    if (!agent) throw new NotFoundError('Agent not found');
  }

  /** C5's second gate: the frozen `EvalCaseInput` types `owner_id` as a bare string. */
  private requireOwnerId(ownerId: string): string {
    if (!UUID_RE.test(ownerId)) throw new ValidationError('owner_id must be a uuid');
    return ownerId;
  }

  /** C5's second gate: the frozen `EvalCaseInput` types `expected_output` as `z.unknown()`. */
  private requireExpectedOutput(blob: unknown): EvalExpectedOutput {
    const parsed = EvalExpectedOutput.safeParse(blob);
    if (!parsed.success) {
      throw new ValidationError('expected_output is not a valid EvalExpectedOutput', {
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
  }

  /** An empty diff would create a case that can only ever error (`empty_diff`, AC-47). */
  private requireInputDiff(diff: string | undefined): string {
    if (diff === undefined || diff.trim() === '') {
      throw new ValidationError('input_diff must not be empty');
    }
    return diff;
  }

  /** `input_meta` is advisory display data — keep what validates, drop the rest. */
  private parseMeta(blob: unknown): unknown {
    const parsed = EvalPrMeta.safeParse(blob);
    return parsed.success ? parsed.data : {};
  }

  /** One case + its last run, in one extra query. Used by the single-case reads. */
  private async toRecord(workspaceId: string, c: EvalCaseDomain): Promise<EvalCaseRecord> {
    const lastRuns = await this.deps.evalRepo.latestRunPerCase(workspaceId, c.ownerId);
    return this.project(c, lastRuns.get(c.id));
  }

  /**
   * Domain → wire (C6). The three jsonb blobs are `unknown` at the repository
   * boundary on purpose (they can hold anything written before this feature
   * existed), so this projection is where they are validated — degrading
   * loudly through `diff_warnings` rather than throwing on stored data.
   */
  private project(c: EvalCaseDomain, lastRun?: EvalRunDomain): EvalCaseRecord {
    const parsed = parseExpectedOutput(c.expectedOutput);
    const expectedOutput = parsed ?? UNPARSEABLE_EXPECTED_OUTPUT;
    const meta = EvalPrMeta.safeParse(c.inputMeta);

    const warnings = parsed
      ? diffWarnings(c.inputDiff, parsed)
      : ['expected_output is not valid EvalExpectedOutput JSON.'];

    return {
      id: c.id,
      owner_kind: c.ownerKind,
      owner_id: c.ownerId,
      name: c.name,
      input_diff: c.inputDiff,
      input_files: c.inputFiles,
      input_meta: meta.success ? meta.data : {},
      expected_output: expectedOutput,
      notes: c.notes,
      source_finding_id: c.sourceFindingId,
      last_run: lastRun && lastRun.finished ? toLastRun(lastRun, expectedOutput) : null,
      diff_warnings: warnings,
    };
  }
}

/** C5 `EvalCaseLastRun`. `produced_count` comes from the run's own C7 blob, not from the case. */
function toLastRun(
  run: EvalRunDomain,
  expected: EvalExpectedOutput,
): EvalCaseRecord['last_run'] {
  const actual = EvalActualOutput.safeParse(run.actualOutput);
  return {
    run_id: run.id,
    ran_at: run.ranAt.toISOString(),
    pass: run.pass,
    expected_count: expected.expectations.length,
    produced_count: actual.success ? actual.data.findings.length : 0,
    duration_ms: run.durationMs,
    cost_usd: run.costUsd,
  };
}
