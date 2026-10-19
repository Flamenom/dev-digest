import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  SettingsUpdate,
  ConnTestRequestHost,
  SecretsStatusDetailed,
  type ConnTestResultHost,
  type SecretKeyStatus,
  type SecretsStatusProvider,
} from '@devdigest/shared';
import { redactSecret } from '../../platform/redact.js';
import { getContext } from '../_shared/context.js';
import { withActors } from '../_shared/actors.js';
import { GITHUB_PROVIDER, GITLAB_PROVIDER, SECRET_KEY_BY_PROVIDER } from './constants.js';
import {
  gitlabCheckToResult,
  rowsToSettings,
  toSecretsStatusDto,
  type ProviderSecretState,
} from './helpers.js';

/**
 * F1 — settings module.
 *   GET  /settings                 → current non-secret prefs (workspace-wide)
 *   GET  /settings/secrets-status  → per-provider booleans + `states` (AC-38)
 *   PUT  /settings                 → set prefs workspace-wide (Q8)
 *   POST /settings/test-connection → test a provider key (OpenAI/Anthropic/OpenRouter/GitHub/GitLab)
 *
 * Secrets are NOT stored here — only non-secret prefs. test-connection reads
 * the key via SecretsProvider and does a cheap live call (listModels / GET user).
 * The key is never echoed back: failure messages pass through `redactSecret`.
 * Access + audit (settings.update / secret.save) are owned by the central
 * route policy (platform/auth/route-policy.ts) — not repeated here.
 */

const UNSET: SecretKeyStatus = { state: 'unset', updatedAt: null, updatedBy: null };

/** AC-41: an undecryptable stored secret is a hard `secret_undecryptable` error, not a failed test. */
function isSecretUndecryptable(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'secret_undecryptable';
}

export default async function settingsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;

  app.get('/settings', async (req) => {
    const { workspaceId } = await getContext(container, req);
    return rowsToSettings(await container.settingsRepo.listRows(workspaceId));
  });

  // Per provider: whether the key is usable (boolean, true ONLY when `set`)
  // and its state / updated_at / updated_by. Values are NEVER returned — the
  // inspector reports state without decrypting into the response, and the
  // strict response schema rejects any extra (length/prefix) field.
  app.get(
    '/settings/secrets-status',
    { schema: { response: { 200: SecretsStatusDetailed } } },
    async (req) => {
      await getContext(container, req);
      const providers = Object.entries(SECRET_KEY_BY_PROVIDER) as [
        SecretsStatusProvider,
        (typeof SECRET_KEY_BY_PROVIDER)[SecretsStatusProvider],
      ][];
      const status = await container.secretsInspector.status(providers.map(([, key]) => key));
      const entries: ProviderSecretState[] = providers.map(([provider, key]) => ({
        provider,
        ...(status.get(key) ?? UNSET),
      }));
      const withActor = await withActors(entries, { updated_by: (e) => e.updatedBy }, (ids) =>
        container.actorDirectory.lookup(ids),
      );
      return toSecretsStatusDto(withActor);
    },
  );

  app.put('/settings', { schema: { body: SettingsUpdate } }, async (req) => {
    const { workspaceId, userId } = await getContext(container, req);
    await container.settingsRepo.upsert(workspaceId, userId, req.body);
    return rowsToSettings(await container.settingsRepo.listRows(workspaceId));
  });

  app.post(
    '/settings/test-connection',
    {
      schema: { body: ConnTestRequestHost },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req): Promise<ConnTestResultHost> => {
      const { provider, key } = req.body;
      try {
        // If the UI supplied a key, persist it (BYO key) before testing so the
        // test reflects — and the rest of the app can use — the new value.
        // Google mode records the acting Admin on the encrypted row (AC-40).
        if (key) {
          if (!container.secrets.set) {
            return { provider, ok: false, message: 'Secrets backend is read-only' };
          }
          const { userId } = await getContext(container, req);
          await container.secretsWriter.set(SECRET_KEY_BY_PROVIDER[provider], key, userId);
          container.invalidateSecretCaches();
        }
        if (provider === GITLAB_PROVIDER) {
          const gl = await container.gitlab();
          return { provider, ...gitlabCheckToResult(await gl.checkToken()) };
        }
        if (provider === GITHUB_PROVIDER) {
          const gh = await container.github();
          const login = await gh.currentLogin();
          return { provider, ok: true, message: `Connected as @${login}` };
        }
        const llm = await container.llm(provider);
        const models = await llm.listModels();
        return { provider, ok: true, message: `OK — ${models.length} models available` };
      } catch (err) {
        // Surfaces as the stable 409 envelope (message names the KEY only).
        if (isSecretUndecryptable(err)) throw err;
        return { provider, ok: false, message: redactSecret((err as Error).message, key) };
      }
    },
  );
}
