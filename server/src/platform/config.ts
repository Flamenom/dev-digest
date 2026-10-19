import 'dotenv/config';
import { z } from 'zod';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { isIP } from 'node:net';
import { ConfigError } from './errors.js';

/**
 * Central, zod-validated environment config. Loaded once at startup.
 *
 * NOTE: secret keys (OPENAI/ANTHROPIC/OPENROUTER/GITHUB_TOKEN) are deliberately
 * NOT in this schema. Feature code must access secrets through SecretsProvider,
 * never via process.env or AppConfig — the SecretsProvider is the one chokepoint
 * that reads process.env directly (see adapters/secrets/local.ts). Listing them
 * here would be dead config that never reaches AppConfig.
 */
/** '' / whitespace-only → undefined (the `.env` template ships empty values). */
const optionalString = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  return t === '' ? undefined : t;
}, z.string().optional());

const EnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .default('postgres://devdigest:devdigest@localhost:5432/devdigest'),
  // Memory/RAG embeddings run on OpenAI (text-embedding-3-small, 1536-dim — the
  // pgvector columns are locked to that). Default OFF so the app makes ZERO
  // OpenAI requests; set EMBEDDINGS_ENABLED=true to turn memory retrieval on.
  EMBEDDINGS_ENABLED: z.string().optional(),
  // repo-intel facade (Tier 1). Default ON — reviews get repo skeleton +
  // callers context. Set REPO_INTEL_ENABLED=false to opt out, in which case
  // every consumer degrades to ripgrep-identical behavior (acceptance #10).
  // Note: even when on, sections only populate once the repo is indexed; an
  // unindexed repo degrades gracefully. Per-agent override: agents.repo_intel.
  REPO_INTEL_ENABLED: z.string().optional(),
  API_PORT: z.coerce.number().int().default(3001),
  WEB_PORT: z.coerce.number().int().default(3000),
  DEVDIGEST_CLONE_DIR: z.string().optional(),
  // Offline mode for repository hosts (GitHub + GitLab): when 'true', every
  // host-resolving container getter rejects with ConfigError BEFORE any
  // network client is built, so persisted PRs/MRs keep being served.
  // Strict enum: a typo (e.g. 'ture', '1') fails loudly at startup instead of
  // silently leaving hosts online. Empty (`DEVDIGEST_HOSTS_OFFLINE=`) → unset,
  // like the other optional knobs.
  DEVDIGEST_HOSTS_OFFLINE: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['true', 'false']).optional(),
  ),
  // PR-list sync-on-open freshness window (seconds). A list open triggers a
  // host sync only when the last SUCCESS is older than this; the same window
  // is the back-off after a FAILED attempt (AC-56/61/62). Empty → default.
  PR_SYNC_TTL_SECONDS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().default(60),
  ),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // `.env` (and .env.example) ship `LOG_LEVEL=` empty; an empty string is not a
  // valid enum member, so coerce '' → undefined to fall through to the default.
  LOG_LEVEL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  ),
  // ── Auth mode + server-mode deployment settings ─────────────────────────────
  // Deliberately plain optional strings: they are validated by
  // validateAuthConfig(), which reports offending SETTINGS by name only. A zod
  // enum/refine here would surface raw ZodError issues that can echo the input
  // (e.g. a secret or a master key) into the boot log.
  AUTH_MODE: optionalString,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  AUTH_ALLOWED_DOMAIN: optionalString,
  /** Comma-separated admin allowlist (trimmed, lower-cased). */
  AUTH_ADMIN_EMAILS: optionalString,
  /** host[:port] only — no scheme, path or userinfo. Origin = https://<host>. */
  PUBLIC_HOSTNAME: optionalString,
  /** base64, exactly 32 bytes after decoding. */
  SECRETS_MASTER_KEY: optionalString,
  SECRETS_MASTER_KEY_PREVIOUS: optionalString,
  /** `true|false` — acknowledgement for local mode with NODE_ENV=production. */
  ALLOW_UNAUTHENTICATED_LOCAL_MODE: optionalString,
  /** Comma-separated IP/CIDR list handed to Fastify `trustProxy`. Unset = trust nothing. */
  TRUST_PROXY: optionalString,
});

export const AUTH_MODES = ['local', 'google'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export type GoogleOidcConfig = {
  clientId: string;
  /** Deployment secret — never log, never persist. */
  clientSecret: string;
};

/** The auth/deploy slice of AppConfig produced by validateAuthConfig(). */
export type AuthConfig = {
  authMode: AuthMode;
  /** Google OIDC client (google mode only, else null). */
  google: GoogleOidcConfig | null;
  /** Lower-cased email/`hd` domain admitted to sign in (google mode only). */
  allowedDomain: string | null;
  /** Lower-cased admin allowlist (google mode only, else []). */
  adminEmails: string[];
  /** `https://<PUBLIC_HOSTNAME>` in google mode; null in local mode. */
  publicOrigin: string | null;
  /** `<publicOrigin>/api` in google mode; null in local mode. */
  publicApiBase: string | null;
  /** Decoded 32-byte master key (google mode only). Never log. */
  masterKey: Buffer | null;
  /** Decoded 32-byte previous master key for rotation (google mode, optional). */
  previousMasterKey: Buffer | null;
  /** Fastify `trustProxy` value: IP/CIDR allowlist, or false (trust nothing). */
  trustProxy: string[] | false;
  /** ALLOW_UNAUTHENTICATED_LOCAL_MODE=true (only meaningful in local mode). */
  allowUnauthenticatedLocal: boolean;
};

export type AppConfig = AuthConfig & {
  databaseUrl: string;
  apiPort: number;
  webPort: number;
  /** Absolute path where repos are cloned (~/.devdigest/workspace by default). */
  cloneDir: string;
  /** Absolute path to the writable secrets store (BYO keys from the UI). */
  secretsPath: string;
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: string;
  /**
   * Allowed CORS origin: `http://localhost:<WEB_PORT>` in local mode, the
   * public origin (`https://<PUBLIC_HOSTNAME>`) in google mode.
   */
  webOrigin: string;
  /** Whether memory/RAG embeddings (OpenAI) are enabled. Default false. */
  embeddingsEnabled: boolean;
  /**
   * Whether the repo-intel facade (Tier 1: phantom-gate, callers-in-prompt) is
   * active. Default ON — set REPO_INTEL_ENABLED=false to opt out, in which case
   * every facade method returns its degraded result (`[]`) so consumers behave
   * EXACTLY like the ripgrep-only baseline.
   */
  repoIntelEnabled: boolean;
  /**
   * DEVDIGEST_HOSTS_OFFLINE=true → no GitHub/GitLab host calls: `prHost()` and
   * `gitlab()` reject with ConfigError (persisted data is still served).
   */
  hostsOffline: boolean;
  /**
   * PR_SYNC_TTL_SECONDS (default 60) in ms — the sync-on-open TTL measured from
   * the last successful sync, and also the back-off after a failed attempt.
   */
  prSyncTtlMs: number;
};

type ParsedEnv = z.infer<typeof EnvSchema>;

// RFC 1123 labels; host[:port]. Anything with a scheme, path, query, fragment,
// userinfo or whitespace fails this pattern.
const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_RE = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})*(?::(\\d{1,5}))?$`, 'i');
const DOMAIN_RE = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})+$`, 'i');
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+$/;
const STRICT_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Strict base64 → exactly 32 bytes, else null. Never echoes the input. */
function decodeMasterKey(raw: string): Buffer | null {
  if (raw.length % 4 !== 0 || !STRICT_BASE64_RE.test(raw)) return null;
  const buf = Buffer.from(raw, 'base64');
  // Canonical round-trip rejects non-zero padding bits / sloppy encodings.
  if (buf.toString('base64') !== raw) return null;
  return buf.length === 32 ? buf : null;
}

function isValidPublicHostname(raw: string): boolean {
  const m = HOSTNAME_RE.exec(raw);
  if (!m) return false;
  if (m[1] !== undefined) {
    const port = Number(m[1]);
    if (port < 1 || port > 65535) return false;
  }
  return true;
}

function isValidProxyEntry(entry: string): boolean {
  const [addr, prefix, ...rest] = entry.split('/');
  if (rest.length > 0 || !addr) return false;
  const family = isIP(addr);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits <= (family === 4 ? 32 : 128);
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Validate the auth-mode / server-mode settings. Collects EVERY offending
 * setting and throws one ConfigError whose message names settings and the rule
 * they broke — never their values (AC-1, AC-3, AC-4).
 *
 * `local` (the default) requires no new variable and leaves every existing
 * behaviour unchanged; google-only settings are ignored in local mode.
 */
export function validateAuthConfig(parsed: ParsedEnv): AuthConfig {
  const problems: string[] = [];

  // TRUST_PROXY + the local-mode acknowledgement are validated in both modes
  // (only when set, so an unset env stays exactly as before).
  let trustProxy: string[] | false = false;
  const proxyEntries = splitList(parsed.TRUST_PROXY);
  if (parsed.TRUST_PROXY !== undefined) {
    if (proxyEntries.length === 0 || !proxyEntries.every(isValidProxyEntry)) {
      problems.push('TRUST_PROXY must be a comma-separated list of IP addresses or CIDR ranges');
    } else {
      trustProxy = proxyEntries;
    }
  }

  let allowUnauthenticatedLocal = false;
  const ack = parsed.ALLOW_UNAUTHENTICATED_LOCAL_MODE;
  if (ack !== undefined) {
    if (ack === 'true') allowUnauthenticatedLocal = true;
    else if (ack !== 'false') problems.push('ALLOW_UNAUTHENTICATED_LOCAL_MODE must be "true" or "false"');
  }

  const rawMode = parsed.AUTH_MODE ?? 'local';
  if (!(AUTH_MODES as readonly string[]).includes(rawMode)) {
    problems.push(`AUTH_MODE must be one of: ${AUTH_MODES.join(', ')}`);
    throw configError(problems);
  }
  const authMode = rawMode as AuthMode;

  if (authMode === 'local') {
    if (parsed.NODE_ENV === 'production' && !allowUnauthenticatedLocal) {
      problems.push(
        'AUTH_MODE=local is unauthenticated and refuses to run with NODE_ENV=production — ' +
          'set AUTH_MODE=google for a shared deployment, or set ALLOW_UNAUTHENTICATED_LOCAL_MODE=true ' +
          'to acknowledge the risk',
      );
    }
    if (problems.length > 0) throw configError(problems);
    return {
      authMode,
      google: null,
      allowedDomain: null,
      adminEmails: [],
      publicOrigin: null,
      publicApiBase: null,
      masterKey: null,
      previousMasterKey: null,
      trustProxy,
      allowUnauthenticatedLocal,
    };
  }

  // ── google mode: every required setting must be present and valid ──────────
  const required = (name: keyof ParsedEnv): string | undefined => {
    const v = parsed[name];
    if (typeof v !== 'string') {
      problems.push(`${name} is required when AUTH_MODE=google`);
      return undefined;
    }
    return v;
  };

  const clientId = required('GOOGLE_CLIENT_ID');
  const clientSecret = required('GOOGLE_CLIENT_SECRET');

  let allowedDomain: string | null = null;
  const domainRaw = required('AUTH_ALLOWED_DOMAIN');
  if (domainRaw !== undefined) {
    if (DOMAIN_RE.test(domainRaw)) allowedDomain = domainRaw.toLowerCase();
    else problems.push('AUTH_ALLOWED_DOMAIN must be a bare domain name (e.g. example.com)');
  }

  let publicOrigin: string | null = null;
  const hostRaw = required('PUBLIC_HOSTNAME');
  if (hostRaw !== undefined) {
    if (isValidPublicHostname(hostRaw)) publicOrigin = `https://${hostRaw.toLowerCase()}`;
    else
      problems.push(
        'PUBLIC_HOSTNAME must be a host name with an optional port (no scheme, path or credentials); ' +
          'the public origin is always https://<PUBLIC_HOSTNAME>',
      );
  }

  let masterKey: Buffer | null = null;
  const keyRaw = required('SECRETS_MASTER_KEY');
  if (keyRaw !== undefined) {
    masterKey = decodeMasterKey(keyRaw);
    if (!masterKey) problems.push('SECRETS_MASTER_KEY must be base64 that decodes to exactly 32 bytes');
  }

  let previousMasterKey: Buffer | null = null;
  if (parsed.SECRETS_MASTER_KEY_PREVIOUS !== undefined) {
    previousMasterKey = decodeMasterKey(parsed.SECRETS_MASTER_KEY_PREVIOUS);
    if (!previousMasterKey)
      problems.push('SECRETS_MASTER_KEY_PREVIOUS must be base64 that decodes to exactly 32 bytes');
  }

  const adminEmails = splitList(parsed.AUTH_ADMIN_EMAILS).map((e) => e.toLowerCase());
  if (!adminEmails.every((e) => EMAIL_RE.test(e))) {
    problems.push('AUTH_ADMIN_EMAILS must be a comma-separated list of email addresses');
  }

  if (problems.length > 0 || !clientId || !clientSecret || !publicOrigin) {
    throw configError(problems);
  }

  return {
    authMode,
    google: { clientId, clientSecret },
    allowedDomain,
    adminEmails: [...new Set(adminEmails)],
    publicOrigin,
    publicApiBase: `${publicOrigin}/api`,
    masterKey,
    previousMasterKey,
    trustProxy,
    // The acknowledgement only applies to local mode.
    allowUnauthenticatedLocal: false,
  };
}

function configError(problems: string[]): ConfigError {
  return new ConfigError(
    `Invalid server configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  const auth = validateAuthConfig(parsed);
  const cloneDirRaw =
    parsed.DEVDIGEST_CLONE_DIR ?? join(homedir(), '.devdigest', 'workspace');
  const cloneDir = isAbsolute(cloneDirRaw) ? cloneDirRaw : resolve(process.cwd(), cloneDirRaw);
  return {
    databaseUrl: parsed.DATABASE_URL,
    apiPort: parsed.API_PORT,
    webPort: parsed.WEB_PORT,
    cloneDir,
    secretsPath: join(homedir(), '.devdigest', 'secrets.json'),
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL ?? (parsed.NODE_ENV === 'test' ? 'silent' : 'info'),
    webOrigin:
      auth.authMode === 'google' && auth.publicOrigin
        ? auth.publicOrigin
        : `http://localhost:${parsed.WEB_PORT}`,
    embeddingsEnabled: parsed.EMBEDDINGS_ENABLED === 'true',
    repoIntelEnabled: parsed.REPO_INTEL_ENABLED !== 'false',
    hostsOffline: parsed.DEVDIGEST_HOSTS_OFFLINE === 'true',
    prSyncTtlMs: parsed.PR_SYNC_TTL_SECONDS * 1000,
    ...auth,
  };
}
