/**
 * Eval case → wire DTO with its creator (multi-user AC-47, Rec-3).
 *
 * The service hands out `EvalCaseView`s carrying the creator's raw user id
 * (`creator_id`); this resolves every id in ONE batched lookup into the
 * `created_by` ActorRef and drops the internal field, so the response is
 * exactly `EvalCaseRecordWithActor`. A legacy case (no creator) or an unknown
 * id renders as `created_by: null` ("—").
 *
 * Presentation-side helper: pure apart from the injected `lookup`.
 */
import type { EvalCaseRecordWithActor } from '@devdigest/shared';
import { withActors, type ActorLookup } from '../_shared/actors.js';
import type { EvalCaseView } from './service.js';

export async function withCaseCreators(
  views: readonly EvalCaseView[],
  lookup: ActorLookup,
): Promise<EvalCaseRecordWithActor[]> {
  const enriched = await withActors(views, { created_by: (v) => v.creator_id }, lookup);
  return enriched.map(({ creator_id: _creatorId, ...dto }) => dto);
}

/** Single-record convenience over {@link withCaseCreators}. */
export async function withCaseCreator(
  view: EvalCaseView,
  lookup: ActorLookup,
): Promise<EvalCaseRecordWithActor> {
  const [dto] = await withCaseCreators([view], lookup);
  // `withCaseCreators` maps 1:1, so a one-element input yields one element.
  return dto!;
}
