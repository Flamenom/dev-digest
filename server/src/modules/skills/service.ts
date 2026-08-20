import type { Container } from '../../platform/container.js';
import type {
  Skill,
  SkillSource,
  SkillStats,
  SkillType,
  SkillUsage,
  SkillVersionEntry,
} from '@devdigest/shared';
import { SkillsRepository } from './repository.js';
import { isBodyChange, restoreNote, toSkillDto, toSkillVersionDto } from './helpers.js';
import { DEFAULT_SKILL_SOURCE } from './constants.js';

/**
 * L02 — skills service. Business logic for the Skills Lab: CRUD with
 * body-versioning, version history, and the usage map.
 *
 * Versioning rule (mirrors the agents module's config-vs-enabled split): a
 * BODY change bumps `version` and snapshots skill_versions (with the optional
 * "what changed" note); enabled/name/description/type-only changes do not.
 * Restore from the UI is a plain update with an old body — it becomes a NEW
 * head version, never a rollback of history.
 */

export interface CreateSkillInput {
  name: string;
  description: string;
  type: SkillType;
  body: string;
  enabled?: boolean;
  source?: SkillSource;
  evidenceFiles?: string[];
}

export interface UpdateSkillInput {
  name?: string;
  description?: string;
  type?: SkillType;
  body?: string;
  enabled?: boolean;
  /** Optional "what changed" note — recorded only when the body changes. */
  note?: string;
}

export class SkillsService {
  private repo: SkillsRepository;

  constructor(container: Container, repo?: SkillsRepository) {
    this.repo = repo ?? new SkillsRepository(container.db);
  }

  async list(workspaceId: string): Promise<Skill[]> {
    const rows = await this.repo.list(workspaceId);
    return rows.map(toSkillDto);
  }

  async get(workspaceId: string, id: string): Promise<Skill | undefined> {
    const row = await this.repo.getById(workspaceId, id);
    return row ? toSkillDto(row) : undefined;
  }

  async create(workspaceId: string, input: CreateSkillInput): Promise<Skill> {
    const row = await this.repo.insert({
      workspaceId,
      name: input.name,
      description: input.description,
      type: input.type,
      body: input.body,
      source: input.source ?? DEFAULT_SKILL_SOURCE,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.evidenceFiles !== undefined ? { evidenceFiles: input.evidenceFiles } : {}),
    });
    return toSkillDto(row);
  }

  async update(
    workspaceId: string,
    id: string,
    patch: UpdateSkillInput,
  ): Promise<Skill | undefined> {
    const existing = await this.repo.getById(workspaceId, id);
    if (!existing) return undefined;

    // Only a body change bumps the version + snapshots (with the note).
    const bump = isBodyChange(existing, patch)
      ? { nextVersion: existing.version + 1, note: patch.note ?? null }
      : undefined;

    const row = await this.repo.update(
      workspaceId,
      id,
      {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      },
      bump,
    );
    return row ? toSkillDto(row) : undefined;
  }

  /** Delete a skill (agent_skills links cascade). */
  async delete(workspaceId: string, id: string): Promise<boolean> {
    return this.repo.deleteById(workspaceId, id);
  }

  /**
   * Body-snapshot history, newest first (bodies included — the client diffs
   * locally). Workspace-scoped: undefined when the skill isn't in this
   * workspace (route → 404), so snapshots can't be read across tenants.
   */
  async listVersions(
    workspaceId: string,
    skillId: string,
  ): Promise<SkillVersionEntry[] | undefined> {
    const skill = await this.repo.getById(workspaceId, skillId);
    if (!skill) return undefined;
    const rows = await this.repo.listVersions(skillId);
    return rows.map(toSkillVersionDto);
  }

  /** One body snapshot; undefined when skill or version is unknown (route → 404). */
  async getVersion(
    workspaceId: string,
    skillId: string,
    version: number,
  ): Promise<SkillVersionEntry | undefined> {
    const skill = await this.repo.getById(workspaceId, skillId);
    if (!skill) return undefined;
    const row = await this.repo.getVersion(skillId, version);
    return row ? toSkillVersionDto(row) : undefined;
  }

  /**
   * Restore an old body snapshot as the NEW head version (never a history
   * rollback): re-applies the snapshot body through the normal update flow, so
   * it bumps `version` and records a "Restored from vN" note. Restoring a body
   * identical to the current one is a no-op (no bump). Undefined when the
   * skill or the requested version is unknown (route -> 404).
   */
  async restore(workspaceId: string, id: string, version: number): Promise<Skill | undefined> {
    const existing = await this.repo.getById(workspaceId, id);
    if (!existing) return undefined;
    const snapshot = await this.repo.getVersion(id, version);
    if (!snapshot) return undefined;
    return this.update(workspaceId, id, {
      body: snapshot.body,
      note: restoreNote(version),
    });
  }

  /**
   * Per-skill stats for the Stats tab in one request: the agents linking the
   * skill, snapshot count, and the newest snapshot's date. Undefined when the
   * skill isn't in this workspace (route -> 404).
   */
  async stats(workspaceId: string, id: string): Promise<SkillStats | undefined> {
    const skill = await this.repo.getById(workspaceId, id);
    if (!skill) return undefined;
    const [agents, versions] = await Promise.all([
      this.repo.agentsUsing(id),
      this.repo.listVersions(id),
    ]);
    return {
      skill_id: skill.id,
      used_by_agents: agents.length,
      agents: agents.map((a) => ({ id: a.id, name: a.name })),
      version_count: versions.length,
      latest_version: skill.version,
      last_updated_at: versions[0]?.createdAt.toISOString() ?? null,
    };
  }

  /**
   * Usage map for the list cards + Stats tab: every workspace skill with the
   * agents linking it (skills with no links appear with an empty agents array).
   */
  async usage(workspaceId: string): Promise<SkillUsage[]> {
    const rows = await this.repo.usage(workspaceId);
    const bySkill = new Map<string, SkillUsage>();
    for (const r of rows) {
      let entry = bySkill.get(r.skillId);
      if (!entry) {
        entry = { skill_id: r.skillId, agents: [] };
        bySkill.set(r.skillId, entry);
      }
      if (r.agentId !== null && r.agentName !== null) {
        entry.agents.push({ id: r.agentId, name: r.agentName });
      }
    }
    return [...bySkill.values()];
  }
}
