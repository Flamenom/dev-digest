import type { ActorRef, ActorRefValue, Role } from '@devdigest/shared';
import { ForbiddenOwnerError } from '../../platform/auth-errors.js';
import { withActors, type ActorLookup } from '../_shared/actors.js';
import { findingRowToDto, reviewToDto, type ReviewDto, type ReviewDtoFinding } from './helpers.js';
import type { FindingRow, ReviewRow, RunSummaryRecord } from './repository.js';

/**
 * Multi-user attribution + ownership for the reviews slice (AC-30, AC-45,
 * AC-46). Pure apart from the injected `lookup` (the `ActorDirectory` batch
 * resolver): no DB, no container, no Fastify.
 */

/** The acting user, as plain arguments (never a request object). */
export interface ReviewActor {
  userId: string;
  role: Role;
}

/**
 * AC-30: only the run's initiator or an Admin may cancel it. A legacy run
 * (null initiator) has no owner, so it is Admin-only.
 */
export function assertCanCancelRun(initiatedBy: string | null, actor: ReviewActor): void {
  if (actor.role === 'admin') return;
  if (initiatedBy !== null && initiatedBy === actor.userId) return;
  throw new ForbiddenOwnerError('Only the user who started this run or an Admin can cancel it');
}

/** Run history rows → wire DTOs with `started_by` (raw `initiatedBy` stripped). */
export async function attachRunActors(rows: readonly RunSummaryRecord[], lookup: ActorLookup) {
  const enriched = await withActors(rows, { started_by: (r) => r.initiatedBy }, lookup);
  return enriched.map(({ initiatedBy: _raw, ...dto }) => dto);
}

/**
 * Reviews (+ findings) → DTOs with `started_by` per review and `acted_by` per
 * finding, resolved with ONE batched lookup across both levels.
 */
export async function attachReviewActors(
  rows: readonly {
    review: ReviewRow;
    findings: FindingRow[];
    initiatedBy: string | null;
    agentName?: string | null;
  }[],
  lookup: ActorLookup,
): Promise<ReviewDto[]> {
  const resolved = await resolveOnce(
    rows.flatMap((r) => [r.initiatedBy, ...r.findings.map((f) => f.actedBy)]),
    lookup,
  );
  return rows.map(({ review, findings, initiatedBy, agentName }) => {
    const dto = reviewToDto(review, findings, agentName);
    return {
      ...dto,
      started_by: refOf(resolved, initiatedBy),
      findings: dto.findings.map((f, i) => ({
        ...f,
        acted_by: refOf(resolved, findings[i]!.actedBy),
      })),
    };
  });
}

/** One finding row → DTO with `acted_by`. */
export async function findingWithActor(
  row: FindingRow,
  lookup: ActorLookup,
): Promise<ReviewDtoFinding> {
  const [dto] = await withActors([findingRowToDto(row)], { acted_by: () => row.actedBy }, lookup);
  return dto!;
}

async function resolveOnce(
  ids: readonly (string | null | undefined)[],
  lookup: ActorLookup,
): Promise<Map<string, ActorRefValue>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  return unique.length > 0 ? lookup(unique) : new Map();
}

function refOf(actors: Map<string, ActorRefValue>, id: string | null | undefined): ActorRef {
  return (id && actors.get(id)) || null;
}
