import type {
  BlastResponse,
  BriefMissingInput,
  BriefStatus,
  ChatMessage,
  FeatureModelChoice,
  Finding,
  IntentDetail,
  IssueMeta,
  LLMProvider,
  PrBriefDetail,
  PrBriefGenerationStatus,
  Provider,
  RepoRef,
} from '@devdigest/shared';
import { PrBriefContent, PrBriefGeneration, riskLevelFromScore } from '@devdigest/shared';
import { NotFoundError } from '../../platform/errors.js';
import {
  latestReviewPerAgent,
  rollupReviews,
  type ReviewRollup,
  type ReviewRollupInput,
} from '../_shared/review-rollup.js';
import type { BriefFinding, BriefWrite, StoredBrief } from './repository.js';
import {
  buildAllowedRefs,
  changeTypeFromPatch,
  computeInputFingerprint,
  groundGeneration,
  mergeMissingInputs,
  staleReason,
  type AllowedRefs,
  type BriefState,
  type PrSpend,
} from './helpers.js';
import { buildBriefMessages, type BriefPromptExcerpt, type BriefPromptFinding } from './prompts.js';

/**
 * PR Brief — the use case (spec `specs/2026-08-27-pr-brief.md`).
 *
 * Two operations, and the difference between them is the whole feature:
 *
 *  - `get`        — a CACHED read. Zero model calls, ever (AC-3, NFR-4). It serves
 *                   the deterministic header plus whatever content is cached, and
 *                   annotates staleness as DATA — never as a trigger (AC-5, N5).
 *  - `regenerate` — EXACTLY ONE structured model call (AC-1), whose output is
 *                   grounded against the PR's own inputs before anything is written
 *                   (AC-11, AC-12), and which persists nothing at all when the call
 *                   fails (AC-36).
 *
 * NFR-7 — the header is deterministic. Status, score, `risk_level`, findings,
 * blockers and cost are computed from persisted review data by
 * `_shared/review-rollup` + `getPrSpend`, so the header is fully correct on every
 * degraded path: no changed files (AC-35), no review (AC-18), a failed model call
 * (AC-36). The model contributes prose, risks and review focus and nothing else
 * ([D1]) — an injected instruction can therefore only write a misleading
 * paragraph, never move a number.
 *
 * TENANCY, fail-closed (AC-37): every entry point resolves the PR through the
 * workspace-scoped `getPull` FIRST and throws `NotFoundError` when it misses, so a
 * cross-workspace request is indistinguishable from a nonexistent PR. `pr_brief`
 * carries no `workspace_id` — it inherits tenancy through the `pr_id` FK — so this
 * resolution is the ONLY thing protecting every read and write below it.
 *
 * Onion: an EXPLICIT deps object, never the `Container`; no Drizzle, no Fastify,
 * no sibling-module import. Cross-module data (intent, blast, PR/review rows)
 * arrives through bindings the composition root wires in.
 */

// ---------------------------------------------------------------- input shapes

/**
 * Structural projections of the rows the service consumes — the repository's
 * Drizzle row types satisfy these without leaking `$inferSelect` inward
 * (`reviews/intent-deriver.ts`, `blast/service.ts` precedent).
 */
export interface BriefPull {
  id: string;
  repoId: string;
  number: number;
  title: string;
  author: string;
  branch: string;
  base: string;
  headSha: string;
  body: string | null;
}

export interface BriefRepo {
  owner: string;
  name: string;
}

export interface BriefPrFile {
  path: string;
  additions: number;
  deletions: number;
  /**
   * Read for the change type (patch HEADER only) and the AC-12 changed-line
   * ranges. The body NEVER reaches the prompt: `BriefPromptFile` has no `patch`
   * field, and the mapping below passes four scalars (AC-2, N6).
   */
  patch: string | null;
}

/** The brief slice's own data access, as an interface so tests inject a fake. */
export interface BriefDataAccess {
  getBrief(prId: string): Promise<StoredBrief | undefined>;
  upsertBrief(prId: string, input: BriefWrite): Promise<void>;
  latestReviewRowsForPull(prId: string): Promise<ReviewRollupInput[]>;
  findingsForReviews(reviewIds: readonly string[]): Promise<BriefFinding[]>;
  blockersForRuns(runIds: readonly string[]): Promise<Map<string, number | null>>;
  getPrSpend(workspaceId: string, prId: string): Promise<PrSpend>;
}

/** Minimal structural logger (pino-compatible `(obj, msg)`) — no framework types inward. */
export interface BriefLogger {
  info: (obj: unknown, msg?: string) => void;
}

/** Explicit deps object — built in the composition root, never `Container`. */
export interface BriefServiceDeps {
  repo: {
    getPull(workspaceId: string, prId: string): Promise<BriefPull | undefined>;
    getRepo(repoId: string): Promise<BriefRepo | undefined>;
    getPrFiles(prId: string): Promise<BriefPrFile[]>;
  };
  briefRepo: BriefDataAccess;
  /**
   * `container.intent`. THROWS `NotFoundError` for a foreign PR and returns
   * `null` for "not classified yet" — only `null` is a missing input (AC-32).
   */
  intent: { get(workspaceId: string, prId: string): Promise<IntentDetail | null> };
  /**
   * `container.blastService`. Never throws for an unindexed repo: it returns a
   * DECLARED `degraded`/`empty` response with a human-readable `reason`. Read
   * `status`; never infer emptiness from empty arrays (AC-33).
   */
  blast: { get(workspaceId: string, prId: string): Promise<BlastResponse> };
  github: () => Promise<{ getIssue(repo: RepoRef, n: number): Promise<IssueMeta> }>;
  git: { readFile(repo: RepoRef, path: string): Promise<string> };
  llm: (id: Provider) => Promise<LLMProvider>;
  /** Resolves the `risk_brief` feature model for the workspace (Rec-5). */
  resolveModel: (workspaceId: string) => Promise<FeatureModelChoice>;
}

// ------------------------------------------------------------------ constants

/** Repo-doc / spec excerpts read per generation, matching the intent classifier's cap. */
const MAX_REPO_DOCS = 4;

/**
 * Explicit issue link and repo-doc mentions in the PR body.
 *
 * Deliberately duplicated from `reviews/intent-helpers.ts` rather than imported:
 * `no-cross-module` forbids importing a sibling module's folder, and Q4 requires
 * the brief to resolve the linked issue "exactly as `deriveIntent` does". Keep
 * the two regexes in step if either ever changes.
 */
function extractIssueRef(body: string | null | undefined): number | undefined {
  const m = (body ?? '').match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
  return m?.[1] ? Number(m[1]) : undefined;
}

function extractRepoDocPaths(body: string | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?:^|[\s(<[`"'])((?:specs|docs)\/[\w./-]+\.md)/gi;
  for (const m of (body ?? '').matchAll(re)) {
    const path = m[1]!;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= MAX_REPO_DOCS) break;
  }
  return out;
}

// ------------------------------------------------------------- internal shapes

/** The deterministic header, plus the review material the generation reads. */
interface HeaderRollup {
  status: BriefStatus;
  rollup: ReviewRollup;
  /** Per-agent-latest reviews. EMPTY is the AC-18 `not_reviewed` signal. */
  latest: ReviewRollupInput[];
  findings: BriefFinding[];
}

/** Intent + blast, gathered once and reused for the fingerprint and the prompt. */
interface GenerationInputs {
  intent: IntentDetail | null;
  blast: BlastResponse | null;
  missing: BriefMissingInput[];
}

/**
 * The single model call's outcome as a discriminated union rather than an
 * exception crossing method boundaries: AC-36 requires the failure path to RETURN
 * a fully-populated deterministic header, so "failed" has to be a value the
 * caller must handle, not a control-flow escape it might forget to catch.
 */
type ModelOutcome =
  | {
      ok: true;
      data: PrBriefGeneration;
      model: string;
      tokensIn: number;
      tokensOut: number;
      costUsd: number | null;
    }
  | { ok: false; model: string | null; reason: string };

// ----------------------------------------------------------------- the service

export class BriefService {
  constructor(private deps: BriefServiceDeps) {}

  /**
   * The PR's cached brief plus its deterministic header. NEVER calls the model
   * and never writes (AC-3, NFR-4).
   *
   * Always 200 (Rec-6): a PR with no cached brief is `not_generated`, not a 404 —
   * the header must render even when there is no content (AC-18a, AC-31, AC-36).
   * The intent 404 pattern is deliberately NOT followed here.
   */
  async get(workspaceId: string, prId: string): Promise<PrBriefDetail> {
    const pull = await this.resolvePull(workspaceId, prId);
    const header = await this.headerRollup(prId);

    const cached = await this.deps.briefRepo.getBrief(prId);

    // Fast path: nothing cached. Skip the intent/blast reads entirely — the
    // fingerprint has nothing to compare against, and NFR-2's 150 ms budget is
    // easiest to hold by not doing the work (AC-18a, AC-31).
    //
    // NOTE `getBrief` also returns undefined when the stored blob no longer
    // matches `PrBriefContent`; that is indistinguishable from "no brief" on
    // purpose. The row is never deleted (N11) and the next regeneration
    // overwrites it in place.
    if (!cached) {
      return this.detail({
        prId,
        header,
        spend: await this.deps.briefRepo.getPrSpend(workspaceId, prId),
        content: null,
        cached: null,
        missing: [],
        stale: null,
        generation: {
          state: 'not_generated',
          reason: 'No brief has been generated for this pull request yet.',
        },
      });
    }

    // A cached brief exists, so the current PR state must be recomputed to decide
    // staleness (AC-4). Both reads are deterministic and bill nothing.
    const inputs = await this.gatherInputs(workspaceId, prId, header);
    const current = this.currentState(pull.headSha, inputs, header.latest);
    const reason = staleReason(current, cached);

    return this.detail({
      prId,
      header,
      spend: await this.deps.briefRepo.getPrSpend(workspaceId, prId),
      content: cached.content,
      cached,
      // The live-recomputed notes (intent / blast / reviews reflect the PR as it
      // is NOW), plus the one-time notes only the generation could observe —
      // a failed linked-issue fetch, an unreadable repo doc, an NFR-3 truncation.
      // Without the persisted half those three vanish on the first read after the
      // POST that produced them, even though the cached brief really was written
      // under those conditions.
      missing: mergeMissingInputs(inputs.missing, cached.missingInputs),
      // Staleness is DATA: reported with a reason, never a regeneration (AC-5, N5).
      stale: reason,
      generation: { state: 'ok', reason: null },
    });
  }

  /**
   * Regenerate the brief: gather inputs → ONE structured model call (AC-1) →
   * ground → persist, replacing the previous entry wholesale (AC-6).
   *
   * Every failure mode returns the full deterministic header rather than an
   * error, and writes nothing (AC-35, AC-36).
   */
  async regenerate(
    workspaceId: string,
    prId: string,
    logger?: BriefLogger,
  ): Promise<PrBriefDetail> {
    const pull = await this.resolvePull(workspaceId, prId);
    const repo = await this.deps.repo.getRepo(pull.repoId);
    if (!repo) throw new NotFoundError('Repo not found');
    const repoRef: RepoRef = { owner: repo.owner, name: repo.name };

    const header = await this.headerRollup(prId);
    const prFiles = await this.deps.repo.getPrFiles(prId);

    // AC-35 — refuse BEFORE any model call. With no changed files there is
    // nothing to ground a reference against, so a generation could only invent.
    if (prFiles.length === 0) {
      return this.detail({
        prId,
        header,
        spend: await this.deps.briefRepo.getPrSpend(workspaceId, prId),
        content: null,
        cached: null,
        missing: [
          {
            input: 'changed_files',
            reason: 'No changed files are recorded for this pull request.',
          },
        ],
        stale: null,
        generation: {
          state: 'unavailable',
          reason:
            'No changed files are recorded for this pull request, so a brief cannot be generated. Re-import the pull request and try again.',
        },
      });
    }

    const inputs = await this.gatherInputs(workspaceId, prId, header);
    const missing = [...inputs.missing];

    // Linked issue (Q4): re-fetched exactly as `deriveIntent` does. One GitHub
    // call per GENERATION, never per cached read; any failure is a missing input,
    // never an error (AC-32 precedent).
    let issue: { ref: string; title?: string | null; body?: string | null } | undefined;
    const issueNumber = extractIssueRef(pull.body);
    if (issueNumber != null) {
      const ref = `#${issueNumber}`;
      try {
        const gh = await this.deps.github();
        const meta = await gh.getIssue(repoRef, issueNumber);
        issue = { ref, title: meta.title, body: meta.body ?? null };
      } catch {
        missing.push({
          input: 'linked_issue',
          reason: `The linked issue ${ref} could not be fetched, so the brief was written without it.`,
        });
      }
    }

    // Repo-doc / spec excerpts from the local clone (no network), same source
    // rule as the intent classifier.
    //
    // The empty-content guard is not cosmetic: `MockGitClient.readFile` returns
    // `''` for a missing file instead of throwing (server/INSIGHTS.md), so
    // without it every probed path would ship an empty `<untrusted>` block.
    const excerpts: BriefPromptExcerpt[] = [];
    for (const path of extractRepoDocPaths(pull.body)) {
      try {
        const content = await this.deps.git.readFile(repoRef, path);
        if (content.trim().length === 0) continue;
        excerpts.push({ kind: path.startsWith('specs/') ? 'spec' : 'repo-doc', path, content });
      } catch {
        missing.push({
          input: 'repo_doc',
          reason: `The referenced document ${path} could not be read from the repository clone.`,
        });
      }
    }

    // AC-10 / AC-33 — the allowed set is derived from diff + blast + findings
    // alone, with no repository walk. `buildAllowedRefs` already contributes
    // NOTHING for a degraded/empty blast; naming the reason is this layer's job
    // and is done in `gatherInputs`.
    const allowed = buildAllowedRefs({
      changedFiles: prFiles.map((f) => ({ path: f.path, patch: f.patch })),
      blast: inputs.blast,
      findings: header.findings,
    });

    // AC-2 / N6 — per-file input is STATISTICS only. The four scalars below are
    // the entire per-file surface of the prompt; `patch` stops here.
    const prompt = buildBriefMessages({
      pull: {
        number: pull.number,
        title: pull.title,
        author: pull.author,
        branch: pull.branch,
        baseBranch: pull.base,
        body: pull.body,
      },
      intent: inputs.intent,
      blast: inputs.blast,
      files: prFiles.map((f) => ({
        path: f.path,
        additions: f.additions,
        deletions: f.deletions,
        changeType: changeTypeFromPatch(f.patch),
      })),
      issue,
      excerpts,
      findings: header.findings.map(toPromptFinding),
    });

    // NFR-3 — truncation is reported honestly rather than silently shrinking the
    // model's view of the PR.
    if (prompt.truncated) {
      missing.push({
        input: 'diff_statistics',
        reason: `The input budget was reached: statistics for ${prompt.filesOmitted} changed file(s) were omitted, largest changes first.`,
      });
    }

    const state = this.currentState(pull.headSha, inputs, header.latest);

    // ---- the single model call (AC-1) -------------------------------------
    const outcome = await this.callModel(workspaceId, prompt.messages);

    // AC-36 / A10 — fail closed on a STATE, never fall through: the header is
    // returned in full, nothing at all has been written, and no partial or
    // fabricated content is persisted.
    if (!outcome.ok) {
      logger?.info(
        {
          feature: 'brief',
          prId,
          model: outcome.model,
          promptSections: prompt.sections,
          tokenEstimate: prompt.estimatedTokens,
          missingInputs: missing.map((m) => m.input),
          outcome: 'failed',
        },
        `brief: generation failed for PR #${pull.number}`,
      );
      return this.detail({
        prId,
        header,
        spend: await this.deps.briefRepo.getPrSpend(workspaceId, prId),
        content: null,
        cached: null,
        missing,
        stale: null,
        generation: {
          state: 'failed',
          reason: `The brief could not be generated: ${outcome.reason}. The review rollup above is unaffected.`,
        },
      });
    }

    // ---- grounding, then persistence -------------------------------------
    // AC-11 / AC-12 / AC-13: refs outside the allowed set are DROPPED, never
    // repaired; a section emptied by grounding persists as `[]` so the UI renders
    // its empty state. This is the brief-local gate over model output — it
    // neither replaces nor relaxes reviewer-core's mandatory grounding gate (N1).
    const grounded = groundContent(outcome.data, allowed);

    const write: BriefWrite = {
      content: grounded,
      headSha: state.headSha,
      fingerprint: state.fingerprint,
      // Persisted so a later GET can still report what this generation could not
      // consult. The read merges these with freshly recomputed notes.
      missingInputs: missing,
      model: outcome.model,
      tokensIn: outcome.tokensIn,
      tokensOut: outcome.tokensOut,
      costUsd: outcome.costUsd,
    };
    await this.deps.briefRepo.upsertBrief(prId, write);

    // ONE structured line per generation — section NAMES AND SIZES only, never a
    // body, a path or a finding title (NFR-6; `reviews/intent-deriver.ts:196-209`
    // is the precedent and the security bar).
    logger?.info(
      {
        feature: 'brief',
        prId,
        model: outcome.model,
        promptSections: prompt.sections,
        tokenEstimate: prompt.estimatedTokens,
        tokensIn: outcome.tokensIn,
        tokensOut: outcome.tokensOut,
        missingInputs: missing.map((m) => m.input),
        risks: grounded.risks.length,
        reviewFocus: grounded.review_focus.length,
        outcome: 'ok',
      },
      `brief: generated for PR #${pull.number}`,
    );

    // Read back for the row's own `updated_at` provenance, and read the spend
    // AFTER the write so this generation's own cost is inside the total (AC-8,
    // AC-9). Freshly written ⇒ never stale.
    const stored = await this.deps.briefRepo.getBrief(prId);
    return this.detail({
      prId,
      header,
      spend: await this.deps.briefRepo.getPrSpend(workspaceId, prId),
      content: grounded,
      cached: stored ?? {
        prId,
        content: grounded,
        headSha: write.headSha,
        fingerprint: write.fingerprint,
        missingInputs: write.missingInputs,
        model: write.model,
        tokensIn: write.tokensIn,
        tokensOut: write.tokensOut,
        costUsd: write.costUsd,
        generatedAt: new Date().toISOString(),
      },
      missing,
      stale: null,
      generation: { state: 'ok', reason: null },
    });
  }

  // -------------------------------------------------------------- internals

  /**
   * The one and only structured model call of this feature (AC-1).
   *
   * Everything that can fail against the provider is inside ONE try — resolving
   * the workspace's `risk_brief` model (Rec-5), building the client, the call
   * itself, and the defensive re-parse — and every failure becomes a value, so
   * the caller cannot skip the AC-36 path.
   *
   * NOTE the caller must have exhausted its cache checks before getting here:
   * this method is unconditional, so calling it twice would bill twice.
   */
  private async callModel(workspaceId: string, messages: ChatMessage[]): Promise<ModelOutcome> {
    let model: string | null = null;
    try {
      const choice = await this.deps.resolveModel(workspaceId);
      model = choice.model;
      const llm = await this.deps.llm(choice.provider);
      const res = await llm.completeStructured<PrBriefGeneration>({
        model: choice.model,
        schema: PrBriefGeneration,
        // Must match `MockLLMProvider.structuredBySchema` fixture keys.
        schemaName: 'PrBriefGeneration',
        messages,
      });

      // Belt and braces over AC-14: the caps live ON the schema (Rec-3), so the
      // provider's own parse-with-repair loop already rejects an over-long or
      // over-numerous answer. `safeParse` here — never `instanceof ZodError`, zod
      // is vendored twice and the shapes are structurally, not nominally, equal —
      // guarantees a violating response can never be persisted even if a provider
      // implementation stops validating.
      const parsed = PrBriefGeneration.safeParse(res.data);
      if (!parsed.success) {
        return {
          ok: false,
          model,
          reason: 'the model response did not match the expected brief shape',
        };
      }

      return {
        ok: true,
        data: parsed.data,
        model: res.model,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        costUsd: res.costUsd,
      };
    } catch (err) {
      return { ok: false, model, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Tenancy gate. Fail-closed: a foreign PR is indistinguishable from a missing one (AC-37). */
  private async resolvePull(workspaceId: string, prId: string): Promise<BriefPull> {
    const pull = await this.deps.repo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');
    return pull;
  }

  /**
   * The deterministic header inputs (AC-15 – AC-18, NFR-7), via the ONE shared
   * rollup rule so the card and the PR list can never disagree.
   */
  private async headerRollup(prId: string): Promise<HeaderRollup> {
    const rows = await this.deps.briefRepo.latestReviewRowsForPull(prId);
    // The repository returns ALL `kind = 'review'` rows newest-first; reducing to
    // the per-agent-latest set is this layer's job.
    const latest = latestReviewPerAgent(rows);

    const findings = await this.deps.briefRepo.findingsForReviews(latest.map((r) => r.id));
    const findingsByReview = new Map<string, BriefFinding[]>();
    for (const finding of findings) {
      const list = findingsByReview.get(finding.reviewId);
      if (list) list.push(finding);
      else findingsByReview.set(finding.reviewId, [finding]);
    }

    const runIds = [...new Set(latest.map((r) => r.runId).filter((id): id is string => id != null))];
    const blockersByRun = await this.deps.briefRepo.blockersForRuns(runIds);

    const rollup = rollupReviews(latest, findingsByReview, blockersByRun);

    // AC-18 — "never reviewed" is the EMPTY per-agent-latest set, which the
    // rollup cannot tell from "reviewed but unscored" (both give score null).
    // Only the empty case reports `not_reviewed`; a reviewed PR whose verdicts
    // are all unrecognised degrades to the same label because `BriefStatus` has
    // no other value for it.
    const status: BriefStatus = latest.length === 0 ? 'not_reviewed' : rollup.verdict ?? 'not_reviewed';

    return { status, rollup, latest, findings };
  }

  /**
   * Intent + blast for the PR, with every absence named honestly (AC-32, AC-33,
   * AC-34). Deterministic and free — no model call on either path.
   */
  private async gatherInputs(
    workspaceId: string,
    prId: string,
    header: HeaderRollup,
  ): Promise<GenerationInputs> {
    const missing: BriefMissingInput[] = [];

    // AC-32 — `intent.get` THROWS for a foreign PR (already excluded by the
    // tenancy gate above) and returns null for "not classified yet". Only null is
    // a missing input; a throw is a real fault and propagates.
    const intent = await this.deps.intent.get(workspaceId, prId);
    if (intent == null) {
      missing.push({
        input: 'intent',
        reason:
          'This pull request has not been classified, so the brief was written without a declared intent.',
      });
    }

    // AC-33 — a degraded/empty blast is a DECLARED response with a reason, not an
    // exception and not an empty array to be inferred. `buildAllowedRefs` already
    // narrows the allowed set for it; naming the reason is this layer's job.
    let blast: BlastResponse | null = null;
    try {
      blast = await this.deps.blast.get(workspaceId, prId);
      if (blast.status === 'degraded' || blast.status === 'empty') {
        missing.push({
          input: 'blast_radius',
          reason:
            blast.reason ??
            'The impact map is unavailable, so references are limited to the pull request diff.',
        });
      }
    } catch {
      missing.push({
        input: 'blast_radius',
        reason:
          'The impact map could not be computed, so references are limited to the pull request diff.',
      });
    }

    // AC-34 — no review run: the generation gets no findings and the focus order
    // can only come from the blast map.
    if (header.latest.length === 0) {
      missing.push({
        input: 'reviews',
        reason:
          'No review has run on this pull request yet, so the reading order is derived from the impact map rather than from findings.',
      });
    }

    return { intent, blast, missing };
  }

  /** The PR state a brief is (or would be) generated for: head SHA + fingerprint (AC-4). */
  private currentState(
    headSha: string,
    inputs: GenerationInputs,
    latest: readonly ReviewRollupInput[],
  ): BriefState {
    return {
      headSha,
      fingerprint: computeInputFingerprint({
        intentHeadSha: inputs.intent?.head_sha ?? null,
        intentGeneratedAt: inputs.intent?.generated_at ?? null,
        blastStatus: inputs.blast?.status ?? null,
        blastCounts: inputs.blast?.counts ?? null,
        // AC-41 is structural: finding ACTIONS are not part of this input, so
        // accepting or dismissing a finding cannot move the fingerprint.
        latestReviewIds: latest.map((r) => r.id),
      }),
    };
  }

  /**
   * Assemble the wire payload. Single place where the header, the content and the
   * generation state meet, so no branch can accidentally ship a partial header.
   */
  private detail(args: {
    prId: string;
    header: HeaderRollup;
    spend: PrSpend;
    content: PrBriefContent | null;
    cached: StoredBrief | null;
    missing: BriefMissingInput[];
    /** `staleReason(...)`: a sentence when the state moved, null when fresh. */
    stale: string | null;
    generation: PrBriefGenerationStatus;
  }): PrBriefDetail {
    const { header, content, cached } = args;
    // [D1] — the score is the deterministic rollup and `risk_level` is derived
    // from it with the score gauge's own breakpoints, so the label and the gauge
    // colour cannot disagree (AC-16, AC-16a). Null score ⇒ null level (AC-18a).
    const score = header.rollup.score;

    return {
      pr_id: args.prId,

      what: content?.what ?? null,
      why: content?.why ?? null,
      risks: content?.risks ?? [],
      review_focus: content?.review_focus ?? [],

      score,
      risk_level: riskLevelFromScore(score),
      status: header.status,
      findings_count: header.rollup.findingsCount,
      blockers: header.rollup.blockers,
      cost_usd: args.spend.costUsd,
      tokens_in: args.spend.tokensIn,
      tokens_out: args.spend.tokensOut,

      missing_inputs: args.missing,

      model: cached?.model ?? null,
      head_sha: cached?.headSha ?? null,
      generated_at: cached?.generatedAt ?? null,

      stale: args.stale !== null,
      stale_reason: args.stale,

      generation: args.generation,
    };
  }
}

// -------------------------------------------------------------- pure mapping

/**
 * `BriefFinding` (DB-facing, `path` + camelCase) → the prompt's contract-shaped
 * projection (`file` + snake_case). The rename happens once, here.
 */
function toPromptFinding(f: BriefFinding): BriefPromptFinding {
  return {
    id: f.id,
    // `findings.severity` / `.category` are free-text DB columns while the
    // contract narrows them to enums. The prompt only ever renders them as text
    // (`severity · category · title · file:line`), so the narrowing cast is safe
    // and is confined to this one boundary rather than widening the contract.
    severity: f.severity as Finding['severity'],
    category: f.category as Finding['category'],
    // AC-39: the review pipeline's ALREADY-REDACTED title, never file content.
    title: f.title,
    file: f.path,
    start_line: f.startLine,
    end_line: f.endLine,
  };
}

/**
 * Compose the persisted content: the model's prose plus its GROUNDED sections.
 * `groundGeneration` returns only `{ risks, review_focus }`, so `what`/`why` are
 * carried across explicitly — they reference nothing and so are ungroundable.
 */
function groundContent(generation: PrBriefGeneration, allowed: AllowedRefs): PrBriefContent {
  const { risks, review_focus } = groundGeneration(generation, allowed);
  return { what: generation.what, why: generation.why, risks, review_focus };
}
