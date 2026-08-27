import { and, asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { SkillSource, SkillType } from '@devdigest/shared';
import { INITIAL_SKILL_VERSION, INITIAL_VERSION_NOTE } from './constants.js';

/**
 * L02 — skills data-access. Owns `skills` and `skill_versions`; reads the
 * `agent_skills` link table (whose agent side is owned by the agents module)
 * for the usage map and the run-time skill resolution. Workspace-scoped
 * throughout; the version-bump DECISION lives in the service (helpers'
 * `isBodyChange`) — this layer only persists what it is told.
 */

export type SkillRow = typeof t.skills.$inferSelect;
export type SkillVersionRow = typeof t.skillVersions.$inferSelect;

export interface InsertSkill {
  workspaceId: string;
  name: string;
  description: string;
  type: SkillType;
  body: string;
  source?: SkillSource;
  enabled?: boolean;
  evidenceFiles?: string[];
}

export interface UpdateSkillPatch {
  name?: string;
  description?: string;
  type?: SkillType;
  body?: string;
  enabled?: boolean;
}

/** Instruction to bump the version + snapshot the (new) body with a note. */
export interface VersionBump {
  nextVersion: number;
  note: string | null;
}

/** One row of the usage join — a skill and (maybe) one agent linking it. */
export interface SkillUsageRow {
  skillId: string;
  agentId: string | null;
  agentName: string | null;
}

export class SkillsRepository {
  constructor(private db: Db) {}

  /** All skills in the workspace, newest first. */
  async list(workspaceId: string): Promise<SkillRow[]> {
    return this.db
      .select()
      .from(t.skills)
      .where(eq(t.skills.workspaceId, workspaceId))
      .orderBy(desc(t.skills.createdAt));
  }

  async getById(workspaceId: string, id: string): Promise<SkillRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.skills)
      .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.id, id)));
    return row;
  }

  /** Delete a skill (scoped to workspace); agent_skills links cascade. */
  async deleteById(workspaceId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(t.skills)
      .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.id, id)))
      .returning({ id: t.skills.id });
    return rows.length > 0;
  }

  /** Insert a skill AND record its v1 body snapshot in skill_versions. */
  async insert(values: InsertSkill): Promise<SkillRow> {
    const [row] = await this.db
      .insert(t.skills)
      .values({
        workspaceId: values.workspaceId,
        name: values.name,
        description: values.description,
        type: values.type,
        source: values.source ?? 'manual',
        body: values.body,
        enabled: values.enabled ?? true,
        ...(values.evidenceFiles !== undefined ? { evidenceFiles: values.evidenceFiles } : {}),
        version: INITIAL_SKILL_VERSION,
      })
      .returning();
    await this.insertVersionSnapshot(
      row!.id,
      INITIAL_SKILL_VERSION,
      row!.body,
      INITIAL_VERSION_NOTE,
    );
    return row!;
  }

  /**
   * Apply a patch; when `bump` is present also set the new version and snapshot
   * the resulting body (+note) into skill_versions.
   */
  async update(
    workspaceId: string,
    id: string,
    patch: UpdateSkillPatch,
    bump?: VersionBump,
  ): Promise<SkillRow | undefined> {
    const [row] = await this.db
      .update(t.skills)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(bump ? { version: bump.nextVersion } : {}),
      })
      .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.id, id)))
      .returning();
    if (bump && row) {
      await this.insertVersionSnapshot(row.id, bump.nextVersion, row.body, bump.note);
    }
    return row;
  }

  /**
   * Replace the ordered attached project-doc paths ONLY (Project Context).
   * Deliberately NOT routed through `update`: attaching docs is not a body
   * change, so it must never bump `version` or snapshot skill_versions (AC-14).
   */
  async setAttachedDocs(
    workspaceId: string,
    id: string,
    paths: string[],
  ): Promise<SkillRow | undefined> {
    const [row] = await this.db
      .update(t.skills)
      .set({ attachedDocPaths: paths })
      .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.id, id)))
      .returning();
    return row;
  }

  private async insertVersionSnapshot(
    skillId: string,
    version: number,
    body: string,
    note: string | null,
  ): Promise<void> {
    await this.db
      .insert(t.skillVersions)
      .values({ skillId, version, body, note })
      .onConflictDoNothing();
  }

  // ---- skill_versions (immutable body snapshots) ---------------------------

  /** All body snapshots for a skill, newest version first (bodies included). */
  async listVersions(skillId: string): Promise<SkillVersionRow[]> {
    return this.db
      .select()
      .from(t.skillVersions)
      .where(eq(t.skillVersions.skillId, skillId))
      .orderBy(desc(t.skillVersions.version));
  }

  /** A single body snapshot, or undefined if that version was never recorded. */
  async getVersion(skillId: string, version: number): Promise<SkillVersionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.skillVersions)
      .where(and(eq(t.skillVersions.skillId, skillId), eq(t.skillVersions.version, version)));
    return row;
  }

  // ---- usage + run-time resolution (agent_skills ⋈ agents) -----------------

  /**
   * Usage join for GET /skills/usage: every workspace skill with the agents
   * linking it (left-joined, so unlinked skills appear with no agent row).
   */
  async usage(workspaceId: string): Promise<SkillUsageRow[]> {
    return this.db
      .select({
        skillId: t.skills.id,
        agentId: t.agents.id,
        agentName: t.agents.name,
      })
      .from(t.skills)
      .leftJoin(t.agentSkills, eq(t.agentSkills.skillId, t.skills.id))
      .leftJoin(t.agents, eq(t.agentSkills.agentId, t.agents.id))
      .where(eq(t.skills.workspaceId, workspaceId))
      .orderBy(desc(t.skills.createdAt), asc(t.agentSkills.order));
  }

  /**
   * The agents linking one skill (GET /skills/:id/stats) — name-ordered.
   * Not workspace-filtered here: the service resolves the skill workspace-scoped
   * first, and agent_skills only links same-workspace rows.
   */
  async agentsUsing(skillId: string): Promise<Array<{ id: string; name: string }>> {
    return this.db
      .select({ id: t.agents.id, name: t.agents.name })
      .from(t.agentSkills)
      .innerJoin(t.agents, eq(t.agentSkills.agentId, t.agents.id))
      .where(eq(t.agentSkills.skillId, skillId))
      .orderBy(asc(t.agents.name));
  }

  /**
   * Run-time resolution (run-executor via container.skillsRepo): the skills
   * linked to an agent, ordered by `agent_skills.order`. Returns enabled AND
   * disabled rows — the caller splits them so it can log the skipped count.
   */
  async resolveAgentSkills(agentId: string): Promise<SkillRow[]> {
    const rows = await this.db
      .select({ skill: t.skills })
      .from(t.agentSkills)
      .innerJoin(t.skills, eq(t.agentSkills.skillId, t.skills.id))
      .where(eq(t.agentSkills.agentId, agentId))
      .orderBy(asc(t.agentSkills.order));
    return rows.map((r) => r.skill);
  }
}
