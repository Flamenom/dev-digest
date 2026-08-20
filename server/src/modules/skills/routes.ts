import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type {} from '@fastify/multipart';
import { SkillSource, SkillType } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { NotFoundError, ValidationError } from '../../platform/errors.js';
import { SkillsService } from './service.js';
import { parseSkillImport } from './import.js';

/** `/skills/:id/versions/:v` — id is a uuid, v a positive integer. */
const VersionParams = z.object({
  id: z.string().uuid(),
  v: z.coerce.number().int().positive(),
});

/**
 * L02 — skills module (Skills Lab).
 *   GET    /skills                  → list (workspace-scoped, newest first)
 *   GET    /skills/usage            → which agents link each skill
 *   POST   /skills/import           → parse-only import preview (persists NOTHING)
 *   GET    /skills/:id              → one skill
 *   POST   /skills                  → create (v1 snapshot in skill_versions)
 *   PUT    /skills/:id              → update; a BODY change bumps version (+note)
 *   DELETE /skills/:id              → delete (agent_skills links cascade)
 *   GET    /skills/:id/stats        → per-skill stats (agents using it, versions)
 *   POST   /skills/:id/restore      → re-apply an old body as a NEW head version
 *   GET    /skills/:id/versions     → body-snapshot history (newest first)
 *   GET    /skills/:id/versions/:v  → one snapshot
 *
 * NOTE: /skills/usage and /skills/import are registered BEFORE /skills/:id
 * (and :id is uuid-validated) so the static paths can never be shadowed by
 * the param route.
 */

const CreateSkillBody = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  type: SkillType,
  body: z.string().min(1),
  enabled: z.boolean().optional(),
  source: SkillSource.optional(),
  /** Provenance of extracted skills — the accepted conventions' evidence paths. */
  evidence_files: z.array(z.string()).optional(),
});

/** POST /skills/:id/restore — which body snapshot to re-apply. */
const RestoreSkillBody = z.object({
  version: z.number().int().positive(),
});

const UpdateSkillBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  type: SkillType.optional(),
  body: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  /** Optional "what changed" note — recorded on the snapshot when body changes. */
  note: z.string().optional(),
});

export default async function skillsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new SkillsService(app.container);

  app.get('/skills', async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return service.list(workspaceId);
  });

  // Static sibling of /skills/:id — registered first so it can't be shadowed.
  app.get('/skills/usage', async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return service.usage(workspaceId);
  });

  // Parse-only import preview. Accepts ONE multipart file (.md or .zip);
  // persists nothing — saving is the client confirming via the normal POST /skills.
  app.post('/skills/import', async (req) => {
    await getContext(app.container, req);
    if (!req.isMultipart()) {
      throw new ValidationError('Expected a multipart file upload');
    }
    const file = await req.file();
    if (!file) throw new ValidationError('No file uploaded');
    let data: Buffer;
    try {
      data = await file.toBuffer();
    } catch {
      // @fastify/multipart aborts the stream at the transport-level cap (2 MB).
      throw new ValidationError('Uploaded file too large (max 2 MB)');
    }
    return parseSkillImport(file.filename, data);
  });

  app.get('/skills/:id', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const skill = await service.get(workspaceId, req.params.id);
    if (!skill) throw new NotFoundError('Skill not found');
    return skill;
  });

  app.post('/skills', { schema: { body: CreateSkillBody } }, async (req, reply) => {
    const { workspaceId } = await getContext(app.container, req);
    const body = req.body;
    const skill = await service.create(workspaceId, {
      name: body.name,
      description: body.description,
      type: body.type,
      body: body.body,
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.source !== undefined ? { source: body.source } : {}),
      ...(body.evidence_files !== undefined ? { evidenceFiles: body.evidence_files } : {}),
    });
    reply.status(201);
    return skill;
  });

  app.put(
    '/skills/:id',
    { schema: { params: IdParams, body: UpdateSkillBody } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const skill = await service.update(workspaceId, req.params.id, req.body);
      if (!skill) throw new NotFoundError('Skill not found');
      return skill;
    },
  );

  app.delete('/skills/:id', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const ok = await service.delete(workspaceId, req.params.id);
    if (!ok) throw new NotFoundError('Skill not found');
    return { ok: true };
  });

  app.get('/skills/:id/stats', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const stats = await service.stats(workspaceId, req.params.id);
    if (!stats) throw new NotFoundError('Skill not found');
    return stats;
  });

  // Restore = re-apply a snapshot body as the NEW head version (with a
  // "Restored from vN" note); history is immutable, nothing is rolled back.
  app.post(
    '/skills/:id/restore',
    { schema: { params: IdParams, body: RestoreSkillBody } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const skill = await service.restore(workspaceId, req.params.id, req.body.version);
      if (!skill) throw new NotFoundError('Skill or version not found');
      return skill;
    },
  );

  app.get('/skills/:id/versions', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const versions = await service.listVersions(workspaceId, req.params.id);
    if (!versions) throw new NotFoundError('Skill not found');
    return versions;
  });

  app.get('/skills/:id/versions/:v', { schema: { params: VersionParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const version = await service.getVersion(workspaceId, req.params.id, req.params.v);
    if (!version) throw new NotFoundError('Skill version not found');
    return version;
  });
}
