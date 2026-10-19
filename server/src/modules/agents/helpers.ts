import type {
  ActorRef,
  Agent,
  AgentListItem,
  AgentVersion,
  CiFailOn,
  Provider,
  ReviewStrategy,
} from '@devdigest/shared';
import { AgentVersionConfig } from '@devdigest/shared';
import { withActors, type ActorLookup } from '../_shared/actors.js';
import type { AgentRow, AgentVersionRow } from './repository.js';

/**
 * Pure helpers for the agents module — DB row ⇄ DTO mapping and the
 * config-version-bump rule. No I/O; behaviour-identical to the previous inline
 * implementations.
 */

/** Map a persisted agent row to the public `Agent` DTO. */
export function toAgentDto(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    provider: row.provider as Provider,
    model: row.model,
    system_prompt: row.systemPrompt,
    output_schema: row.outputSchema ?? null,
    enabled: row.enabled,
    version: row.version,
    strategy: row.strategy as ReviewStrategy,
    ci_fail_on: row.ciFailOn as CiFailOn,
    repo_intel: row.repoIntel,
    attached_doc_paths: row.attachedDocPaths,
  };
}

/** GET /agents list item — the `Agent` DTO plus its linked-skill count. */
export function toAgentListItemDto(row: AgentRow, skillCount: number): AgentListItem {
  return { ...toAgentDto(row), skill_count: skillCount };
}

/**
 * Map a persisted `agent_versions` row to the public `AgentVersion` DTO. The
 * stored `config_json` is untyped jsonb (a snapshot from an older config shape
 * could drift), so it is parsed through `AgentVersionConfig` — a malformed
 * snapshot throws here rather than leaking an unvalidated blob to the client.
 */
export function toAgentVersionDto(row: AgentVersionRow): AgentVersion {
  return {
    agent_id: row.agentId,
    version: row.version,
    config: AgentVersionConfig.parse(row.configJson),
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * Fields whose change bumps the agent's config version (anything but `enabled`).
 * `attachedDocPaths` is deliberately EXCLUDED (AC-14): attach/detach/reorder of
 * project-context docs is mutable config written via the dedicated
 * `setAttachedDocs` repository method and must never bump the version or
 * snapshot agent_versions. Do not add it here.
 */
export interface ConfigChangePatch {
  name?: string;
  description?: string;
  provider?: Provider;
  model?: string;
  systemPrompt?: string;
  outputSchema?: unknown;
  strategy?: ReviewStrategy;
  ciFailOn?: CiFailOn;
  repoIntel?: boolean;
}

/**
 * True when a patch changes config (vs. just toggling `enabled`) relative to the
 * existing row — a config change bumps the version and snapshots agent_versions.
 */
export function isConfigChange(
  existing: Pick<
    AgentRow,
    | 'name'
    | 'description'
    | 'provider'
    | 'model'
    | 'systemPrompt'
    | 'strategy'
    | 'ciFailOn'
    | 'repoIntel'
  >,
  patch: ConfigChangePatch,
): boolean {
  return (
    (patch.name !== undefined && patch.name !== existing.name) ||
    (patch.description !== undefined && patch.description !== existing.description) ||
    (patch.provider !== undefined && patch.provider !== existing.provider) ||
    (patch.model !== undefined && patch.model !== existing.model) ||
    (patch.systemPrompt !== undefined && patch.systemPrompt !== existing.systemPrompt) ||
    (patch.strategy !== undefined && patch.strategy !== existing.strategy) ||
    (patch.ciFailOn !== undefined && patch.ciFailOn !== existing.ciFailOn) ||
    (patch.repoIntel !== undefined && patch.repoIntel !== existing.repoIntel) ||
    patch.outputSchema !== undefined
  );
}

// ---- Actor attribution (multi-user, AC-47) ---------------------------------

/**
 * Raw actor ids a service result carries to the route. The route resolves them
 * into `ActorRef`s with ONE batched lookup (`presentAgents` / `presentVersions`)
 * and strips the raw ids from the response. Legacy / seeded rows → null.
 */
export interface AgentActorIds {
  created_by_id: string | null;
  updated_by_id: string | null;
}
export interface VersionAuthorId {
  author_id: string | null;
}

export type WithAgentActorIds<T extends Agent> = T & AgentActorIds;
export type AgentVersionWithAuthorId = AgentVersion & VersionAuthorId;

/** Response shape: the DTO plus resolved creator / last updater. */
export type WithAgentActors<T extends Agent> = T & {
  created_by: ActorRef;
  updated_by: ActorRef;
};
/** Response shape: a version DTO plus its resolved author. */
export type AgentVersionWithAuthorRef = AgentVersion & { author: ActorRef };

export function agentActorIds(row: Pick<AgentRow, 'createdBy' | 'updatedBy'>): AgentActorIds {
  return { created_by_id: row.createdBy ?? null, updated_by_id: row.updatedBy ?? null };
}

/** `toAgentDto` + the row's raw actor ids. */
export function toAgentRecord(row: AgentRow): WithAgentActorIds<Agent> {
  return { ...toAgentDto(row), ...agentActorIds(row) };
}

/** `toAgentListItemDto` + the row's raw actor ids. */
export function toAgentListRecord(
  row: AgentRow,
  skillCount: number,
): WithAgentActorIds<AgentListItem> {
  return { ...toAgentListItemDto(row, skillCount), ...agentActorIds(row) };
}

/** `toAgentVersionDto` + the snapshot's raw author id. */
export function toAgentVersionRecord(row: AgentVersionRow): AgentVersionWithAuthorId {
  return { ...toAgentVersionDto(row), author_id: row.authorId ?? null };
}

/** Resolve `created_by` / `updated_by` for agent records and drop the raw ids. */
export async function presentAgents<T extends Agent>(
  records: readonly WithAgentActorIds<T>[],
  lookup: ActorLookup,
): Promise<Array<WithAgentActors<T>>> {
  const enriched = await withActors(
    records,
    { created_by: (r) => r.created_by_id, updated_by: (r) => r.updated_by_id },
    lookup,
  );
  return enriched.map(({ created_by_id: _c, updated_by_id: _u, ...dto }) => dto as WithAgentActors<T>);
}

/** Single-record convenience over `presentAgents`. */
export async function presentAgent<T extends Agent>(
  record: WithAgentActorIds<T>,
  lookup: ActorLookup,
): Promise<WithAgentActors<T>> {
  const [one] = await presentAgents([record], lookup);
  return one!;
}

/** Resolve each version's `author` and drop the raw id. */
export async function presentVersions(
  records: readonly AgentVersionWithAuthorId[],
  lookup: ActorLookup,
): Promise<AgentVersionWithAuthorRef[]> {
  const enriched = await withActors(records, { author: (r) => r.author_id }, lookup);
  return enriched.map(({ author_id: _a, ...dto }) => dto);
}
