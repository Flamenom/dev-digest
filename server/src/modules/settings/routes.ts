import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  SettingsUpdate,
  ConnTestRequestHost,
  type ConnTestResultHost,
  type SecretsStatusHost,
} from '@devdigest/shared';
import { redactSecret } from '../../platform/redact.js';
import { getContext } from '../_shared/context.js';
import { GITHUB_PROVIDER, GITLAB_PROVIDER, SECRET_KEY_BY_PROVIDER } from './constants.js';
import { gitlabCheckToResult, rowsToSettings } from './helpers.js';

/**
 * F1 — settings module.
 *   GET  /settings                 → current non-secret prefs
 *   PUT  /settings                 → upsert prefs (key/value rows)
 *   POST /settings/test-connection → test a provider key (OpenAI/Anthropic/OpenRouter/GitHub/GitLab)
 *
 * Secrets are NOT stored here — only non-secret prefs. test-connection reads
 * the key via SecretsProvider and does a cheap live call (listModels / GET user).
 * The key is never echoed back: failure messages pass through `redactSecret`.
 */

export default async function settingsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;

  app.get('/settings', async (req) => {
    const { workspaceId } = await getContext(container, req);
    return rowsToSettings(await container.settingsRepo.listRows(workspaceId));
  });

  // Which provider keys are configured (booleans only — the values are NEVER
  // returned). Drives the "Configured / Not set" badges in the API Keys panel.
  app.get('/settings/secrets-status', async (req): Promise<SecretsStatusHost> => {
    await getContext(container, req);
    const entries = await Promise.all(
      (Object.entries(SECRET_KEY_BY_PROVIDER) as [keyof SecretsStatusHost, string][]).map(
        async ([provider, key]) => [provider, Boolean(await container.secrets.get(key))] as const,
      ),
    );
    return Object.fromEntries(entries) as SecretsStatusHost;
  });

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
      if (key) {
        if (!container.secrets.set) {
          return { provider, ok: false, message: 'Secrets backend is read-only' };
        }
        await container.secrets.set(SECRET_KEY_BY_PROVIDER[provider], key);
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
      return { provider, ok: false, message: redactSecret((err as Error).message, key) };
    }
  });
}
