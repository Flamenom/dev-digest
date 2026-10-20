import type { ActorRef, ActorRefValue } from '@devdigest/shared';

/**
 * Actor enrichment for response DTOs (multi-user Rec-3). Repositories persist
 * and return raw actor ids only; a route maps its DTOs, then calls
 * `withActors` to resolve every id with ONE batched lookup (backed by
 * `container.actorDirectory.lookup`, a single `IN (...)` query).
 *
 * Pure apart from the injected `lookup`: no DB, no container, no Fastify.
 */

/** Batch id → actor resolver (the `ActorDirectory.lookup` shape). */
export type ActorLookup = (ids: readonly string[]) => Promise<Map<string, ActorRefValue>>;

/** Output key → how to read that actor's user id off a DTO (null/undefined = no actor). */
export type ActorFields<T, K extends string> = Readonly<
  Record<K, (dto: T) => string | null | undefined>
>;

/**
 * Return copies of `dtos` with each `fields` key set to an `ActorRef`:
 * the resolved `{ user_id, name, is_system? }`, or `null` when the id is
 * null/undefined or unknown to the directory (UI renders "—").
 * `lookup` is called at most once, with de-duplicated ids, and not at all
 * when no DTO carries an actor.
 */
export async function withActors<T extends object, K extends string>(
  dtos: readonly T[],
  fields: ActorFields<T, K>,
  lookup: ActorLookup,
): Promise<Array<T & Record<K, ActorRef>>> {
  const keys = Object.keys(fields) as K[];
  const ids = new Set<string>();
  for (const dto of dtos) {
    for (const key of keys) {
      const id = fields[key](dto);
      if (id) ids.add(id);
    }
  }
  const actors = ids.size > 0 ? await lookup([...ids]) : new Map<string, ActorRefValue>();
  return dtos.map((dto) => {
    const refs = {} as Record<K, ActorRef>;
    for (const key of keys) {
      const id = fields[key](dto);
      refs[key] = (id && actors.get(id)) || null;
    }
    return { ...dto, ...refs };
  });
}

/**
 * The single element of a one-element batch result (the `presentX(record)`
 * conveniences over the batch enrichers, which map 1:1). Throws — instead of a
 * `!` assertion — if that contract is ever broken, naming the caller.
 */
export function onlyResult<T>(results: readonly T[], what: string): T {
  const [first] = results;
  if (results.length !== 1 || first === undefined) {
    throw new Error(`${what}: expected exactly one result, got ${results.length}`);
  }
  return first;
}
