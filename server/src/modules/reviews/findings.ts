import type { FindingActionKind } from '@devdigest/shared';
import { AppError, NotFoundError } from '../../platform/errors.js';
import type { ReviewRepository } from './repository.js';
import type { ReviewDtoFinding } from './helpers.js';
import type { ActorLookup } from '../_shared/actors.js';
import { findingWithActor } from './actors.js';

/**
 * Finding actions available in the starter: accept / dismiss. These decisions
 * are the dataset later lessons build on (eval cases from accept/dismiss, the
 * `learn → memory` action, etc.).
 */
export async function actOnFinding(
  repo: ReviewRepository,
  workspaceId: string,
  findingId: string,
  action: FindingActionKind,
  /** The acting user, recorded as `findings.acted_by` (AC-46). */
  actorUserId: string | null,
  lookup: ActorLookup,
): Promise<{ finding: ReviewDtoFinding }> {
  const ctx = await repo.findingContext(findingId);
  if (!ctx || ctx.pull.workspaceId !== workspaceId) {
    throw new NotFoundError('Finding not found');
  }

  switch (action) {
    case 'accept': {
      const row = await repo.setFindingAccepted(findingId, new Date(), actorUserId);
      return { finding: await findingWithActor(row!, lookup) };
    }
    case 'dismiss': {
      const row = await repo.setFindingDismissed(findingId, new Date(), actorUserId);
      return { finding: await findingWithActor(row!, lookup) };
    }
    default:
      throw new AppError('invalid_action', `Action '${action}' is not available in the starter`, 400);
  }
}
