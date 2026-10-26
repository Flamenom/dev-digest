/**
 * The background publish algorithm (spec `specs/2026-10-21-gitlab-publish-findings.md`,
 * AC-12 refs use, AC-13, AC-23 – AC-33, AC-41, AC-42; plan T8), extended for
 * deprecated runs (spec `specs/2026-10-23-gitlab-publish-outdated-findings.md`,
 * AC-6 – AC-12, AC-14 – AC-17, AC-25 – AC-28; plan T8). Application ring: no
 * Container, no Fastify, no Drizzle.
 *
 * Anchor source (decided once by the service, never re-read here — AC-28):
 * `persisted` = the service's anchors + live refs (base, byte-identical);
 * `reviewed_version` = step 0 looks up the reviewed MR diff version and plans
 * against it with the version's own SHAs (AC-6, AC-7); `none` = every finding
 * general (AC-9).
 *
 * Write rules (the duplicate / stray-draft guarantees):
 * - a draft create or `bulk_publish` is NEVER re-sent after an `unconfirmed`
 *   answer — only list reads and (idempotent) deletes repeat;
 * - `bulk_publish` publishes every own draft, human ones included, so it is
 *   never called without ≥ 1 draft of this publication (AC-29, D-3);
 * - `bulk_publish_sent_at` is persisted BEFORE the request is sent.
 *
 * Logs carry ids, codes and counts only — never a body, the summary or a token.
 */
import type {
  FindingCategory,
  GitLabDiffRefs,
  GitLabDiffVersionsHost,
  GitLabDraftNotesHost,
  GitLabDraftPosition,
  GitLabWriteFailure,
  HostRepoRef,
  PublishAnchorKind,
  PublishErrorCode,
  WaitBudget,
} from '@devdigest/shared';
import { parseMarker, buildMarker } from '../_shared/publish-marker.js';
import { compareForSend, generalAnchor, singleLineFallback, type PlannedAnchor } from './anchor.js';
import { planAnchors, resolveReviewedVersion, type PlanAnchorSource } from './anchor-source.js';
import { PUBLISH_MESSAGES, PUBLISH_UNCONFIRMED_MESSAGE, failureToPublicationCode } from './codes.js';
import {
  composeFindingNote,
  composeSummary,
  downgradeForSingleLine,
  type ComposedNote,
  type NoteFinding,
} from './note-body.js';
import type {
  AnchorSource,
  FinishPublicationPatch,
  MarkItemDraftedOptions,
  PublicationItemAnchorKind,
  PublishAudit,
  PublishDeprecationState,
  PublishClock,
  PublishFindingRow,
  PublishLogger,
  PublishStore,
  PublishedItemLink,
} from './ports.js';
import {
  errorCode,
  matchPublishedNotes,
  noteUrl,
  recordPublishAudit,
  settleFromHost,
  settledOutcome,
  type SettleItem,
} from './reconciler.js';

// ---------- Input ----------

export interface PublishRunItem {
  finding: PublishFindingRow;
  /**
   * Planned against the persisted MR diff (AC-9 – AC-11) when `anchorSource` is
   * `persisted`; null = decided in the background (step 0) for `reviewed_version`
   * / `none` (outdated-findings AC-6, AC-9, AC-11).
   */
  anchor: PlannedAnchor | null;
}

/** An item after step 0: its anchor is final. */
interface ResolvedRunItem {
  finding: PublishFindingRow;
  anchor: PlannedAnchor;
}

/** The anchors + refs every create of this run uses — fixed after step 0 (AC-28). */
interface ResolvedRun {
  items: ResolvedRunItem[];
  /** The live refs (persisted) or the reviewed version's own SHAs (AC-7). */
  refs: GitLabDiffRefs;
}

/** Everything one background publish needs; built by the service after its synchronous checks. */
export interface PublishRunInput {
  publicationId: string;
  workspaceId: string;
  reviewId: string;
  prId: string;
  actorUserId: string | null;
  repoRef: HostRepoRef;
  /** MR iid. */
  iid: number;
  /** Project web URL (no trailing slash needed). */
  webUrl: string;
  /**
   * The live diff refs read synchronously before the 202 (AC-12). Positions use
   * them only for `anchorSource: 'persisted'`; a version-anchored run uses the
   * version's SHAs instead (outdated-findings AC-7).
   */
  refs: GitLabDiffRefs;
  /** The token user — only its notes are matched by marker (AC-24). */
  serviceAccount: string;
  /** The gated client resolved by the service (never re-resolved here). */
  host: GitLabDraftNotesHost & GitLabDiffVersionsHost;
  items: PublishRunItem[];
  /** Raw user summary (validated); null when none. Never logged. */
  summary: string | null;
  applySuggestions: boolean;
  /** Sanitised footer name (google mode) or null (local mode, AC-42). */
  footerName: string | null;
  /** Shared 429 wait budget of this publication (AC-28). */
  budget: WaitBudget;
  /**
   * Decided once at publish start (outdated-findings AC-3, AC-28): null = not
   * deprecated (base bodies, no AC-12 fallback).
   */
  deprecation: PublishDeprecationState | null;
  /** Where the anchors come from (plan "Anchor-source decision"). */
  anchorSource: AnchorSource;
  /** The review's `head_sha` — the head the reviewed version is looked up by (AC-6). */
  reviewHeadSha: string | null;
}

export interface PublishExecutorDeps {
  store: PublishStore;
  /** null ⇒ local mode: no audit events (AC-42). */
  audit: PublishAudit;
  clock: PublishClock;
  log: PublishLogger;
}

// ---------- Helpers ----------

interface DraftedItem {
  findingId: string;
  anchorKind: PublishAnchorKind;
  applicable: boolean;
  /** Drafted by the AC-12 general re-send. */
  fallback: boolean;
}

interface RunState {
  /** ≥ 1 GitLab write (create / delete / bulk) was sent — the AC-41 audit precondition. */
  wrote: boolean;
  drafted: DraftedItem[];
  failed: string[];
  /** A create answered `unconfirmed` (its draft may have landed). */
  uncertainCreate: boolean;
  otherDrafts: number;
  /** null when no version lookup happened (AC-25). */
  reviewedVersionFound: boolean | null;
}

function toNoteFinding(f: PublishFindingRow): NoteFinding {
  return {
    severity: f.severity,
    // Persisted from the validated `Finding` contract; only interpolated as text.
    category: f.category as FindingCategory,
    title: f.title,
    rationale: f.rationale,
    suggestion: f.suggestion,
    kind: f.kind,
    evidence: f.evidence,
  };
}

/** The draft position of a planned anchor (AC-11, AC-12); null for a general note (AC-9). */
export function toDraftPosition(anchor: PlannedAnchor, refs: GitLabDiffRefs): GitLabDraftPosition | null {
  if (anchor.kind === 'general') return null;
  const base: GitLabDraftPosition = {
    baseSha: refs.baseSha,
    startSha: refs.startSha,
    headSha: refs.headSha,
    oldPath: anchor.oldPath,
    newPath: anchor.path,
    oldLine: anchor.anchorOldLine,
    newLine: anchor.anchorLine,
  };
  if (anchor.kind === 'single_line') return base;
  return {
    ...base,
    lineRange: {
      start: { oldLine: anchor.rangeStart.oldLine, newLine: anchor.rangeStart.newLine },
      end: { oldLine: anchor.rangeEnd.oldLine, newLine: anchor.rangeEnd.newLine },
    },
  };
}

/** `bulk_publish` failures: a definitive 4xx is not a position problem. */
function bulkFailureCode(failure: GitLabWriteFailure): PublishErrorCode {
  return failure.kind === 'rejected' ? 'gitlab_publish_failed' : failureToPublicationCode(failure);
}

// ---------- Executor ----------

export class PublishExecutor {
  constructor(private readonly deps: PublishExecutorDeps) {}

  /** Runs one publication to a terminal (or `unconfirmed`) state. Never throws. */
  async run(input: PublishRunInput): Promise<void> {
    const state: RunState = {
      wrote: false,
      drafted: [],
      failed: [],
      uncertainCreate: false,
      otherDrafts: 0,
      reviewedVersionFound: null,
    };
    try {
      await this.execute(input, state);
    } catch (err) {
      // Unexpected (store) failure: hand the outcome to the reconciler rather than
      // guess — it settles by reading GitLab and never re-sends a write.
      this.deps.log.error({ publicationId: input.publicationId, code: errorCode(err) }, 'publish task crashed');
      try {
        await this.deps.store.finish(input.publicationId, ['in_progress'], {
          status: 'unconfirmed',
          code: 'gitlab_publish_unconfirmed',
          message: PUBLISH_UNCONFIRMED_MESSAGE,
          finishedAt: null,
        });
      } catch (finishErr) {
        // Left `in_progress`; the 10-minute rule reconciles it (AC-34).
        this.deps.log.error({ publicationId: input.publicationId, code: errorCode(finishErr) }, 'publish finish failed');
      }
    }
  }

  private async execute(input: PublishRunInput, state: RunState): Promise<void> {
    const { store } = this.deps;
    const { host, repoRef, iid, publicationId, workspaceId } = input;

    // 0. Anchor source (outdated-findings AC-6 – AC-11). Fixed from here on (AC-28).
    const run = await this.resolveRun(input, state);
    if (!run) return;

    // 1. Existing drafts (AC-23).
    let existing: { id: number; note: string }[];
    try {
      existing = await host.listOwnDraftNotes(repoRef, iid);
    } catch (err) {
      this.deps.log.warn({ publicationId, code: errorCode(err) }, 'publish: listing drafts failed');
      // Nothing was written: release the items so the findings stay selectable (AC-30, AC-35).
      await store.markItemsRolledBack(publicationId, input.items.map((i) => i.finding.id));
      await this.finalize(input, state, this.failedPatch(state, 'gitlab_publish_failed'));
      return;
    }
    const staleDrafts: { id: number; publicationId: string; findingId: string }[] = [];
    for (const draft of existing) {
      const marker = parseMarker(draft.note);
      if (marker && marker.workspaceId === workspaceId) {
        staleDrafts.push({ id: draft.id, publicationId: marker.publicationId, findingId: marker.findingId });
      } else {
        state.otherDrafts += 1; // human / other workspace: never touched, published with the batch
      }
    }
    let leftover = false;
    const cleared: typeof staleDrafts = [];
    for (const stale of staleDrafts) {
      state.wrote = true;
      try {
        await host.deleteDraftNote(repoRef, iid, stale.id);
        cleared.push(stale);
      } catch (err) {
        leftover = true;
        this.deps.log.warn({ publicationId, code: errorCode(err) }, 'publish: stale draft delete failed');
      }
    }
    const oldPublications = [...new Set(cleared.map((s) => s.publicationId).filter((p) => p !== publicationId))];
    if (oldPublications.length > 0) {
      await store.rollBackLeftoverFindings(
        oldPublications,
        cleared.filter((s) => s.publicationId !== publicationId).map((s) => s.findingId),
      );
    }
    if (leftover) {
      // A stale marked draft would go out with bulk_publish: stop before any create.
      await store.markItemsRolledBack(publicationId, input.items.map((i) => i.finding.id));
      await this.finalize(input, state, this.failedPatch(state, 'gitlab_drafts_left_behind'));
      return;
    }
    await store.setOtherDrafts(publicationId, state.otherDrafts);

    // 2. One draft per finding, in send order (AC-25).
    const ordered = [...run.items].sort((a, b) => compareForSend(a.finding, b.finding));
    for (const item of ordered) {
      const stop = await this.createOne(input, state, item, run.refs);
      if (stop) {
        await this.rollback(input, state, stop);
        return;
      }
    }

    // 3. Nothing drafted → never publish human drafts alone (AC-29, Q5).
    if (state.drafted.length === 0) {
      await this.finalize(input, state, this.failedPatch(state, 'gitlab_position_rejected'));
      return;
    }

    // 4. Exactly one bulk_publish (AC-26); persisted before sending.
    await store.setBulkPublishSent(publicationId, this.deps.clock.now());
    state.wrote = true;
    const result = await host.bulkPublishDraftNotes(
      repoRef,
      iid,
      { note: input.summary != null ? composeSummary(input.summary, input.footerName, input.deprecation) : null },
      { waitBudget: input.budget },
    );
    if (result.ok) {
      await this.readBack(input, state);
      return;
    }
    if (result.failure.kind === 'unconfirmed') {
      await this.reconcileAfterBulk(input, state);
      return;
    }
    await this.rollback(input, state, bulkFailureCode(result.failure));
  }

  /**
   * Step 0: the final anchors and refs of this run. `persisted` keeps the
   * service's anchors and the live refs (base). `reviewed_version` reads the
   * versions list + one version diff (AC-6); `none` reads nothing (AC-9).
   * Returns null when the publication already ended (`fatal`, AC-8): 0 writes,
   * items rolled back, no audit.
   */
  private async resolveRun(input: PublishRunInput, state: RunState): Promise<ResolvedRun | null> {
    if (input.anchorSource === 'persisted') {
      return {
        // A persisted run always carries its anchors; null is not expected (defensive general).
        items: input.items.map((i) => ({
          finding: i.finding,
          anchor: i.anchor ?? generalAnchor(i.finding, 'not_on_diff_line'),
        })),
        refs: input.refs,
      };
    }

    const findings = input.items.map((i) => i.finding);
    let source: PlanAnchorSource;
    let refs = input.refs;
    if (input.anchorSource === 'reviewed_version' && input.reviewHeadSha != null) {
      const resolved = await resolveReviewedVersion(
        input.host,
        input.repoRef,
        input.iid,
        input.reviewHeadSha,
        this.deps.log,
      );
      if (resolved.kind === 'fatal') {
        // AC-8: no access — nothing was written; release the findings (selectable again).
        await this.deps.store.markItemsRolledBack(input.publicationId, findings.map((f) => f.id));
        await this.finalize(input, state, this.failedPatch(state, resolved.code));
        return null;
      }
      state.reviewedVersionFound = resolved.kind === 'found';
      if (resolved.kind === 'found') refs = resolved.refs; // AC-7: the version's SHAs, never the live refs
      source = resolved;
    } else {
      source = { kind: 'none' };
    }

    const planned = planAnchors(findings, source);
    const items: ResolvedRunItem[] = findings.map((f) => ({
      finding: f,
      anchor: planned.get(f.id) ?? generalAnchor(f, 'reviewed_version_unavailable'),
    }));
    const kinds: PublicationItemAnchorKind[] = items.map((i) => ({ findingId: i.finding.id, anchorKind: i.anchor.kind }));
    await this.deps.store.setAnchorResolution(input.publicationId, {
      reviewedVersionFound: state.reviewedVersionFound,
      items: kinds,
      diffHeadSha: source.kind === 'found' ? refs.headSha : null,
    });
    return { items, refs };
  }

  /**
   * Creates one draft: the AC-13 single-line re-send, then — deprecated runs only —
   * one AC-12 general re-send after a definitive 400/422. At most 3 creates.
   * Returns a stop code, or null to continue.
   */
  private async createOne(
    input: PublishRunInput,
    state: RunState,
    item: ResolvedRunItem,
    refs: GitLabDiffRefs,
  ): Promise<PublishErrorCode | null> {
    const { store } = this.deps;
    const { host, repoRef, iid, publicationId } = input;
    const finding = toNoteFinding(item.finding);
    const marker = buildMarker({
      workspaceId: input.workspaceId,
      publicationId,
      findingId: item.finding.id,
    });
    const base = {
      finding,
      applySuggestion: input.applySuggestions,
      marker,
      footerName: input.footerName,
      deprecation: input.deprecation,
    };

    const send = async (anchor: PlannedAnchor, note: ComposedNote, opts?: MarkItemDraftedOptions) => {
      state.wrote = true;
      const res = await host.createDraftNote(
        repoRef,
        iid,
        { note: note.body, position: toDraftPosition(anchor, refs) },
        { waitBudget: input.budget },
      );
      if (res.ok) {
        await store.markItemDrafted(publicationId, item.finding.id, res.value.id, opts);
        state.drafted.push({
          findingId: item.finding.id,
          anchorKind: anchor.kind,
          applicable: note.suggestionApplicable,
          fallback: opts?.positionFallback === true,
        });
      } else if (res.failure.kind === 'unconfirmed') {
        state.uncertainCreate = true;
      }
      return res;
    };

    const first = await send(item.anchor, composeFindingNote({ ...base, anchor: item.anchor }));
    if (first.ok) return null;
    if (first.failure.kind !== 'rejected') return failureToPublicationCode(first.failure);
    let lastStatus = first.failure.status;

    if (item.anchor.kind === 'multi_line' && first.failure.status === 400) {
      // AC-13: one single-line re-send at `end`; a range-dependent suggestion is downgraded.
      const fallback = singleLineFallback(item.anchor);
      const second = await send(fallback, downgradeForSingleLine({ ...base, anchor: fallback }));
      if (second.ok) return null;
      if (second.failure.kind !== 'rejected') return failureToPublicationCode(second.failure);
      lastStatus = second.failure.status;
    }

    if (
      input.deprecation != null &&
      item.anchor.kind !== 'general' &&
      (lastStatus === 400 || lastStatus === 422)
    ) {
      // Outdated-findings AC-12: one general re-send (same marker) after a definitive
      // position rejection. Never after `unconfirmed` — handled above.
      const general = generalAnchor(item.finding, 'position_rejected');
      const third = await send(general, composeFindingNote({ ...base, anchor: general }), {
        anchorKind: 'general',
        positionFallback: true,
      });
      if (third.ok) return null;
      if (third.failure.kind !== 'rejected') return failureToPublicationCode(third.failure);
    }

    // AC-29: a definitive per-finding rejection — fail this finding, continue.
    await store.markItemFailed(publicationId, item.finding.id, 'gitlab_position_rejected');
    state.failed.push(item.finding.id);
    return null;
  }

  /** AC-26 / AC-27: after a confirmed publish, link the notes by marker. */
  private async readBack(input: PublishRunInput, state: RunState): Promise<void> {
    const now = this.deps.clock.now();
    let found = new Map<string, { id: number; discussionId: string }>();
    try {
      const notes = await input.host.listMrNotes(input.repoRef, input.iid);
      found = matchPublishedNotes(notes, input, input.serviceAccount);
    } catch (err) {
      // Published for sure; only the links are unknown (AC-27).
      this.deps.log.warn({ publicationId: input.publicationId, code: errorCode(err) }, 'publish: read-back failed');
    }
    const links: PublishedItemLink[] = state.drafted.map((d) => {
      const note = found.get(d.findingId);
      return note
        ? {
            findingId: d.findingId,
            discussionId: note.discussionId,
            noteId: note.id,
            url: noteUrl(input.webUrl, input.iid, note.id),
            publishedAt: now,
          }
        : { findingId: d.findingId, discussionId: null, noteId: null, url: null, publishedAt: now };
    });
    await this.deps.store.markItemsPublished(input.publicationId, links);
    const outcome = settledOutcome({
      requested: input.items.length,
      published: links.length,
      deleteFailed: false,
      nothingCode: 'gitlab_publish_failed',
    });
    await this.finalize(input, state, {
      status: outcome.status,
      code: outcome.code,
      message: outcome.message,
      finishedAt: now,
      counters: this.counters(state, state.drafted),
    });
  }

  /** AC-32 / AC-33: `bulk_publish` unconfirmed — settle by reading, never re-send. */
  private async reconcileAfterBulk(input: PublishRunInput, state: RunState): Promise<void> {
    const { store, clock } = this.deps;
    const items: SettleItem[] = state.drafted.map((d) => ({
      findingId: d.findingId,
      state: 'drafted',
      anchorKind: d.anchorKind,
    }));
    const result = await settleFromHost(
      {
        host: input.host,
        ref: input.repoRef,
        iid: input.iid,
        webUrl: input.webUrl,
        serviceAccount: input.serviceAccount,
        workspaceId: input.workspaceId,
        publicationId: input.publicationId,
      },
      items,
      clock.now(),
    );
    if (result.kind === 'unreadable') {
      // AC-33: not terminal (no audit); the selected findings stay blocked until reconciled.
      await this.finalize(input, state, {
        status: 'unconfirmed',
        code: 'gitlab_publish_unconfirmed',
        message: PUBLISH_UNCONFIRMED_MESSAGE,
        finishedAt: null,
        counters: this.counters(state, state.drafted, { keepDraftedFacts: true }),
      });
      return;
    }
    if (result.links.length > 0) await store.markItemsPublished(input.publicationId, result.links);
    if (result.rolledBack.length > 0) await store.markItemsRolledBack(input.publicationId, result.rolledBack);
    const publishedIds = new Set(result.links.map((l) => l.findingId));
    const outcome = settledOutcome({
      requested: input.items.length,
      published: result.links.length,
      deleteFailed: result.deleteFailed,
      nothingCode: 'gitlab_publish_unconfirmed',
    });
    await this.finalize(input, state, {
      status: outcome.status,
      code: outcome.code,
      message: outcome.message,
      finishedAt: clock.now(),
      counters: this.counters(
        state,
        state.drafted.filter((d) => publishedIds.has(d.findingId)),
      ),
    });
  }

  /** AC-28 / AC-30 / AC-31: delete this publication's marked drafts only; nothing published. */
  private async rollback(input: PublishRunInput, state: RunState, code: PublishErrorCode): Promise<void> {
    const { host, repoRef, iid, publicationId, workspaceId } = input;
    const mayHaveDrafts = state.drafted.length > 0 || state.uncertainCreate;
    let leftBehind = false;
    try {
      const drafts = await host.listOwnDraftNotes(repoRef, iid);
      for (const draft of drafts) {
        const marker = parseMarker(draft.note);
        if (!marker || marker.workspaceId !== workspaceId || marker.publicationId !== publicationId) continue;
        state.wrote = true;
        try {
          await host.deleteDraftNote(repoRef, iid, draft.id);
        } catch (err) {
          leftBehind = true;
          this.deps.log.warn({ publicationId, code: errorCode(err) }, 'publish: rollback delete failed');
        }
      }
    } catch (err) {
      if (mayHaveDrafts) leftBehind = true;
      this.deps.log.warn({ publicationId, code: errorCode(err) }, 'publish: rollback list failed');
    }
    const failed = new Set(state.failed);
    const open = input.items.map((i) => i.finding.id).filter((id) => !failed.has(id));
    if (open.length > 0) await this.deps.store.markItemsRolledBack(publicationId, open);
    await this.finalize(input, state, this.failedPatch(state, leftBehind ? 'gitlab_drafts_left_behind' : code));
  }

  // ---------- Terminal transition ----------

  private failedPatch(state: RunState, code: PublishErrorCode): FinishPublicationPatch {
    return {
      status: 'failed',
      code,
      message: PUBLISH_MESSAGES[code],
      finishedAt: this.deps.clock.now(),
      counters: this.counters(state, []),
    };
  }

  /**
   * Counters for `finish`. `general_notes` / `applicable_suggestions` count the
   * PUBLISHED notes; `other_drafts_published` is 0 when nothing was published.
   * For `unconfirmed` the drafted facts are kept so a later reconcile can use them.
   */
  private counters(
    state: RunState,
    published: readonly DraftedItem[],
    opts: { keepDraftedFacts?: boolean } = {},
  ): NonNullable<FinishPublicationPatch['counters']> {
    const facts = opts.keepDraftedFacts ? state.drafted : published;
    return {
      drafted: state.drafted.length,
      published: opts.keepDraftedFacts ? 0 : published.length,
      failed: state.failed.length,
      generalNotes: facts.filter((d) => d.anchorKind === 'general').length,
      applicableSuggestions: facts.filter((d) => d.applicable).length,
      otherDraftsPublished: facts.length > 0 ? state.otherDrafts : 0,
      positionFallbacks: facts.filter((d) => d.fallback).length,
    };
  }

  /** CAS from `in_progress`; exactly one audit event on a won TERMINAL transition after a write (AC-41). */
  private async finalize(input: PublishRunInput, state: RunState, patch: FinishPublicationPatch): Promise<void> {
    const won = await this.deps.store.finish(input.publicationId, ['in_progress'], patch);
    if (patch.status !== 'published') {
      this.deps.log.warn(
        { publicationId: input.publicationId, status: patch.status, code: patch.code, won },
        'publish ended without a full publish',
      );
    }
    if (!won || !state.wrote || patch.status === 'unconfirmed') return;
    const c = patch.counters ?? {};
    await recordPublishAudit(this.deps.audit, this.deps.log, {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      reviewId: input.reviewId,
      prId: input.prId,
      publicationId: input.publicationId,
      outcome: patch.status,
      requested: input.items.length,
      published: c.published ?? 0,
      failed: c.failed ?? 0,
      generalNotes: c.generalNotes ?? 0,
      otherDraftsPublished: c.otherDraftsPublished ?? 0,
      applicableSuggestions: c.applicableSuggestions ?? 0,
      hasSummary: input.summary != null,
      deprecated: input.deprecation != null,
      deprecationReason: input.deprecation?.reason ?? null,
      reviewedVersionFound: state.reviewedVersionFound,
      positionFallbacks: c.positionFallbacks ?? 0,
    });
  }
}
