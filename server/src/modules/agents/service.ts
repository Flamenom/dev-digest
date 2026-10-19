import type { Container } from '../../platform/container.js';
import type {
  Agent,
  AgentListItem,
  AgentSkillLink,
  CiFailOn,
  EvalPromoteResult,
  ModelInfo,
  Provider,
  ReviewStrategy,
} from '@devdigest/shared';
import { AgentVersionConfig } from '@devdigest/shared';
import { ValidationError } from '../../platform/errors.js';
import { AgentsRepository } from './repository.js';
import {
  toAgentListRecord,
  toAgentRecord,
  toAgentVersionRecord,
  type AgentVersionWithAuthorId,
  type WithAgentActorIds,
} from './helpers.js';

/**
 * A2 — agents service. Business logic for the Agents tab + Agent Editor.
 * Provider/model selection uses the LLM adapter's dynamic model list.
 *
 * An Agent = provider + model + system_prompt + linked skills + output_schema +
 * enabled. Config changes are versioned via `agent_versions` (repository).
 */

// Re-exported for backwards compatibility; implementation lives in ./helpers.
export { toAgentDto } from './helpers.js';

export interface CreateAgentInput {
  name: string;
  description?: string;
  provider: Provider;
  model: string;
  system_prompt: string;
  output_schema?: unknown;
  strategy?: ReviewStrategy;
  ci_fail_on?: CiFailOn;
  repo_intel?: boolean;
  enabled?: boolean;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  provider?: Provider;
  model?: string;
  system_prompt?: string;
  output_schema?: unknown;
  strategy?: ReviewStrategy;
  ci_fail_on?: CiFailOn;
  repo_intel?: boolean;
  enabled?: boolean;
}

/**
 * Order-insensitive structural comparison of two JSON-ish values, rendered as a
 * canonical string with object keys sorted. Used only to decide whether a
 * snapshot's `output_schema` genuinely differs from the live one: `isConfigChange`
 * deliberately treats ANY `outputSchema !== undefined` as a config change
 * (`helpers.ts`), so replaying an identical schema would bump the version and
 * break the "identical config ⇒ changed: false" rule (AC-32).
 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export class AgentsService {
  private repo: AgentsRepository;

  constructor(private container: Container) {
    this.repo = new AgentsRepository(container.db);
  }

  /*
   * Multi-user (AC-47): results carry the raw actor ids (`created_by_id`,
   * `updated_by_id`, versions `author_id`); the route resolves them into
   * ActorRefs (`presentAgents` / `presentVersions`). `actorId` parameters are
   * the acting user from `getContext` — the seeded system user in local mode
   * (AC-49). Omitted ⇒ attribution columns are left untouched.
   */

  async list(workspaceId: string): Promise<WithAgentActorIds<AgentListItem>[]> {
    const rows = await this.repo.listWithSkillCounts(workspaceId);
    return rows.map((r) => toAgentListRecord(r.agent, r.skillCount));
  }

  async get(workspaceId: string, id: string): Promise<WithAgentActorIds<Agent> | undefined> {
    const row = await this.repo.getById(workspaceId, id);
    return row ? toAgentRecord(row) : undefined;
  }

  /** Delete an agent (and its versions/skill-links, via cascade). */
  async delete(workspaceId: string, id: string): Promise<boolean> {
    return this.repo.deleteById(workspaceId, id);
  }

  async create(
    workspaceId: string,
    input: CreateAgentInput,
    userId?: string,
  ): Promise<WithAgentActorIds<Agent>> {
    const row = await this.repo.insert({
      workspaceId,
      name: input.name,
      description: input.description,
      provider: input.provider,
      model: input.model,
      systemPrompt: input.system_prompt,
      outputSchema: input.output_schema,
      ...(input.strategy !== undefined ? { strategy: input.strategy } : {}),
      ...(input.ci_fail_on !== undefined ? { ciFailOn: input.ci_fail_on } : {}),
      ...(input.repo_intel !== undefined ? { repoIntel: input.repo_intel } : {}),
      enabled: input.enabled,
      createdBy: userId ?? null,
    });
    return toAgentRecord(row);
  }

  async update(
    workspaceId: string,
    id: string,
    patch: UpdateAgentInput,
    actorId?: string,
  ): Promise<WithAgentActorIds<Agent> | undefined> {
    const row = await this.repo.update(
      workspaceId,
      id,
      {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.system_prompt !== undefined ? { systemPrompt: patch.system_prompt } : {}),
      ...(patch.output_schema !== undefined ? { outputSchema: patch.output_schema } : {}),
      ...(patch.strategy !== undefined ? { strategy: patch.strategy } : {}),
      ...(patch.ci_fail_on !== undefined ? { ciFailOn: patch.ci_fail_on } : {}),
      ...(patch.repo_intel !== undefined ? { repoIntel: patch.repo_intel } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      },
      actorId,
    );
    return row ? toAgentRecord(row) : undefined;
  }

  /**
   * Replace the agent's ordered attached project-context doc paths (paths only,
   * never document text). Does NOT bump the config version (AC-14). Returns
   * undefined when the agent isn't in this workspace (route → 404).
   */
  async setAttachedDocs(
    workspaceId: string,
    id: string,
    paths: string[],
    actorId?: string,
  ): Promise<WithAgentActorIds<Agent> | undefined> {
    const row =
      actorId === undefined
        ? await this.repo.setAttachedDocs(workspaceId, id, paths)
        : await this.repo.setAttachedDocs(workspaceId, id, paths, actorId);
    return row ? toAgentRecord(row) : undefined;
  }

  /**
   * Config history for an agent, newest version first. Workspace-scoped: returns
   * undefined when the agent isn't in this workspace (the route maps that to 404)
   * so version snapshots can't be read across tenants.
   */
  async listVersions(
    workspaceId: string,
    agentId: string,
  ): Promise<AgentVersionWithAuthorId[] | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    const rows = await this.repo.listVersions(agentId);
    return rows.map(toAgentVersionRecord);
  }

  /**
   * A single config snapshot for an agent. Returns undefined when the agent isn't
   * in this workspace OR that version was never recorded (route → 404).
   */
  async getVersion(
    workspaceId: string,
    agentId: string,
    version: number,
  ): Promise<AgentVersionWithAuthorId | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    const row = await this.repo.getVersion(agentId, version);
    return row ? toAgentVersionRecord(row) : undefined;
  }

  /**
   * Promote a stored config snapshot back onto the live agent (AC-31, AC-32).
   *
   * Deliberately goes through the SAME path as `PUT /agents/:id` —
   * `update` → `isConfigChange` → `snapshotVersion` — instead of re-implementing
   * version-bump semantics: history is append-only, so promoting v7 while the
   * agent is at v9 creates **v10** with v7's settings, exactly like a git revert.
   * Nothing is rewritten and every past eval batch keeps pointing at the version
   * it really ran.
   *
   * `output_schema` is passed ONLY when it actually differs, because
   * `isConfigChange` counts any defined `outputSchema` as a change; passing it
   * unconditionally would bump the version even for an identical config.
   * `attached_doc_paths` is not part of a snapshot and is never touched here.
   *
   * Returns undefined when the agent isn't in this workspace OR that version was
   * never recorded (the route maps both to 404, never 403). Throws 422 when the
   * stored snapshot is malformed and cannot be applied.
   */
  async promoteVersion(
    workspaceId: string,
    agentId: string,
    version: number,
    actorId?: string,
  ): Promise<(EvalPromoteResult & { agent: WithAgentActorIds<Agent> }) | undefined> {
    const existing = await this.get(workspaceId, agentId);
    if (!existing) return undefined;

    const snapshot = await this.repo.getVersion(agentId, version);
    if (!snapshot) return undefined;

    // `config_json` is untyped jsonb; an older/drifted snapshot must not be
    // applied blindly to the live agent.
    const parsed = AgentVersionConfig.safeParse(snapshot.configJson);
    if (!parsed.success) {
      throw new ValidationError(`Stored config for version ${version} is not a valid snapshot`, {
        version,
        issues: parsed.error.issues,
      });
    }
    const config = parsed.data;

    const outputSchemaChanged =
      canonicalJson(config.output_schema) !== canonicalJson(existing.output_schema);

    const agent = await this.update(
      workspaceId,
      agentId,
      {
        provider: config.provider,
        model: config.model,
        system_prompt: config.system_prompt,
        strategy: config.strategy,
        ci_fail_on: config.ci_fail_on,
        repo_intel: config.repo_intel,
        ...(outputSchemaChanged ? { output_schema: config.output_schema ?? null } : {}),
      },
      actorId,
    );
    if (!agent) return undefined;

    return {
      agent,
      promoted_from_version: version,
      // A config change bumped the version inside `repo.update`; an identical
      // config left it untouched, which is exactly AC-32's `changed: false`.
      new_version: agent.version,
      changed: agent.version !== existing.version,
    };
  }

  /** Linked skills for an agent as AgentSkillLink[] (ordered). */
  async skillLinks(agentId: string): Promise<AgentSkillLink[]> {
    const links = await this.repo.linkedSkills(agentId);
    return links.map((l) => ({ agent_id: agentId, skill_id: l.skill.id, order: l.order }));
  }

  /**
   * Set / reorder the agent's linked skills. If `skillIds` is provided, replaces
   * the whole set in that order. Returns the resulting ordered links.
   */
  async setSkills(
    workspaceId: string,
    agentId: string,
    skillIds: string[],
    actorId?: string,
  ): Promise<AgentSkillLink[] | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    await this.repo.setSkills(agentId, skillIds);
    if (actorId !== undefined) await this.repo.touchUpdatedBy(workspaceId, agentId, actorId);
    return this.skillLinks(agentId);
  }

  /** Link a single skill (append or set order) — additive to existing links. */
  async linkSkill(
    workspaceId: string,
    agentId: string,
    skillId: string,
    order?: number,
    actorId?: string,
  ): Promise<AgentSkillLink[] | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    const existing = await this.repo.linkedSkills(agentId);
    const resolvedOrder = order ?? existing.length;
    await this.repo.linkSkill(agentId, skillId, resolvedOrder);
    if (actorId !== undefined) await this.repo.touchUpdatedBy(workspaceId, agentId, actorId);
    return this.skillLinks(agentId);
  }

  /**
   * Dynamic model list from the provider adapter's /models. Degrades gracefully
   * to [] if the provider key is not configured (the editor still renders).
   */
  async listModels(provider: Provider): Promise<ModelInfo[]> {
    try {
      const llm = await this.container.llm(provider);
      return await llm.listModels();
    } catch {
      return [];
    }
  }
}
