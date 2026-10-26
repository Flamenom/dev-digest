import type {
  AuthProvider,
  SecretsProvider,
  GitHubClient,
  HostGitClient,
  HostCodeIndex,
  Embedder,
  LLMProvider,
  GitLabClient,
  GitLabCommentsHost,
  GitLabDraftNotesHost,
  GitLabDiffVersionsHost,
  GitLabScopeCheck,
  GitCredential,
  GitCredentialResolver,
  HostRepoRef,
  PullRequestHost,
  RepoProvider,
  SecretKey,
  ActorDirectory,
  AuditLog,
  Clock,
  IdentityProvider,
  PrincipalProvider,
  SecretKeyStatus,
  SecretsInspector,
  SecretsWriter,
} from '@devdigest/shared';
import type { AppConfig } from './config.js';
import type { Db } from '../db/client.js';
import { JobRunner } from './jobs.js';
import { runBus, type RunBus } from './sse.js';
import { LocalSecretsProvider } from '../adapters/secrets/local.js';
import { EncryptedSecretsProvider } from '../adapters/secrets/encrypted.js';
import { LocalNoAuthProvider } from '../adapters/auth/local.js';
import { GoogleIdentityProvider } from '../adapters/oidc/index.js';
import { OctokitGitHubClient } from '../adapters/github/octokit.js';
import { GitHubPullRequestHost } from '../adapters/github/host.js';
// The gitlab barrel is imported directly (not via adapters/index.ts): only the
// composition root may construct the concrete client.
import { RestGitLabClient, type FetchLike } from '../adapters/gitlab/index.js';
import { SimpleGitClient } from '../adapters/git/simple-git.js';
import { RipgrepCodeIndex } from '../adapters/codeindex/ripgrep.js';
import { OpenAIProvider } from '../adapters/llm/openai.js';
import { AnthropicProvider } from '../adapters/llm/anthropic.js';
import { OpenAIEmbedder } from '../adapters/embedder/openai.js';
import { OpenRouterProvider } from '@devdigest/reviewer-core';
import { estimateCost } from '../adapters/llm/pricing.js';
import { PriceBook } from './price-book.js';
import { ConfigError } from './errors.js';
import { AgentsRepository } from '../modules/agents/repository.js';
import { SkillsRepository } from '../modules/skills/repository.js';
import { ReviewRepository } from '../modules/reviews/repository.js';
import {
  PullRequestRepository,
  PullsReadRepository,
  SyncStatusRepository,
  type PullRequestStore,
} from '../modules/pulls/repository.js';
import { PrListSyncService, type SyncLogger, type SyncRepo } from '../modules/pulls/sync-service.js';
import { PrSyncCoordinator } from '../modules/pulls/sync-coordinator.js';
import { PullDetailService, type PullDetail } from '../modules/pulls/detail-service.js';
import { PullListService } from '../modules/pulls/list-service.js';
import { PrCommentsService, type PrComments } from '../modules/pulls/comments-service.js';
import type { RepoIntel } from '../modules/repo-intel/types.js';
import { RepoIntelService } from '../modules/repo-intel/service.js';
import { INDEX_JOB_KIND, REFRESH_JOB_KIND } from '../modules/repo-intel/constants.js';
import { RepoRepository } from '../modules/repos/repository.js';
import { RepoService, type RepoOperations } from '../modules/repos/service.js';
import { createIntentDeriver, type IntentDeriver } from '../modules/reviews/intent-deriver.js';
import { SmartDiffService } from '../modules/smart-diff/service.js';
import { BlastService } from '../modules/blast/service.js';
import { BlastRepository } from '../modules/blast/repository.js';
import { BriefService } from '../modules/brief/service.js';
import { BriefRepository } from '../modules/brief/repository.js';
import { EvalRepository } from '../modules/eval/repository.js';
import { EvalRunner } from '../modules/eval/runner.js';
import { EvalDashboardService } from '../modules/eval/dashboard.js';
import { EvalService } from '../modules/eval/service.js';
import { resolveFeatureModel } from '../modules/settings/feature-models.js';
import { SettingsRepository, type SettingsTx } from '../modules/settings/repository.js';
import { SettingsService, type SettingsActor } from '../modules/settings/service.js';
import {
  GitLabTokenHealthService,
  type UsableGitLabToken,
} from '../modules/settings/gitlab-token-health.js';
import { GitLabTokenService } from '../modules/settings/gitlab-token-service.js';
import { SECRET_KEY_BY_PROVIDER } from './secret-keys.js';
import { IdentityRepository } from '../modules/identity/repository.js';
import { PrincipalService } from '../modules/identity/principal-service.js';
import { SignInService } from '../modules/identity/sign-in-service.js';
import { MembersService } from '../modules/identity/members-service.js';
import { TokensService } from '../modules/identity/tokens-service.js';
import { AuditRepository, type AuditTx } from '../modules/audit/repository.js';
import { SecretStoreRepository, type SecretsTx } from '../modules/secrets/repository.js';
import { SecretsMaintenance, type BatchSecretStore, type SecretsLogger } from '../modules/secrets/service.js';
import { PublishRepository } from '../modules/publish/repository.js';
import { PublishExecutor } from '../modules/publish/executor.js';
import { PublishRunner } from '../modules/publish/runner.js';
import { PublishReconciler } from '../modules/publish/reconciler.js';
import { PublishService } from '../modules/publish/service.js';
import type { PublishAudit, PublishGitLabAccess, PublishLogger } from '../modules/publish/ports.js';
import { type DepGraph, DepCruiseGraph } from '../adapters/depgraph/index.js';
import { type Tokenizer, TiktokenTokenizer } from '../adapters/tokenizer/index.js';

/**
 * DI container. One per app instance. Holds config, db, the JobRunner,
 * the SSE bus, and lazily-constructed adapters resolved through SecretsProvider.
 *
 * Tests construct a container with `overrides` to inject mock adapters; the
 * Services depend on these interfaces, not the concrete classes.
 */
/**
 * L06 — the eval slice's SINGLE container seam.
 *
 * DEVIATION FROM THE PLAN, stated rather than hidden: T13 specifies
 * `evalService?: EvalService` on the overrides, but `modules/eval/routes.ts`
 * translates R1–R13 and R15–R17 across THREE application objects (case CRUD,
 * the batch runner, the read-side aggregation) and `EvalService` exposes only
 * the first. Widening it to a named three-field seam keeps the plan's actual
 * requirement — ONE getter, ONE `EvalRepository`, one override slot — while
 * letting the routes reach the runner and the dashboard without a second
 * getter or a pass-through facade with 12 forwarding methods.
 */
export interface EvalServices {
  /** R1–R8: case CRUD and one-click creation from a judged finding. */
  cases: EvalService;
  /** R9: batch execution (the in-flight lock lives on this instance). */
  runner: EvalRunner;
  /** R10–R13, R15–R17: aggregation, compare, run-all. */
  dashboard: EvalDashboardService;
}

export interface ContainerOverrides {
  secrets?: SecretsProvider;
  auth?: AuthProvider;
  github?: GitHubClient;
  /**
   * gitlab.com client (read side + diff discussions) — tests inject
   * `MockGitLabClient`. Also answers the token scope check (`checkTokenScopes`).
   */
  gitlab?: GitLabClient & GitLabCommentsHost & GitLabDraftNotesHost & GitLabDiffVersionsHost;
  /** fetch used by the real GitLab client (it-tests run a fake GitLab over it). */
  gitlabFetch?: FetchLike;
  /** fetch used by the real GitHub client (it-tests count requests at this level). */
  githubFetch?: typeof fetch;
  /** PR/MR inline comments use case (`/pulls/:id/comments`) — tests inject a fake. */
  prComments?: PrComments;
  /** Publish-findings use case (`/reviews/:id/publications`, …) — hermetic route tests inject one over fakes. */
  publishService?: PublishService;
  git?: HostGitClient;
  codeIndex?: HostCodeIndex;
  embedder?: Embedder;
  /** Pre-built providers by id (skip key lookup). */
  llm?: Partial<Record<'openai' | 'anthropic' | 'openrouter', LLMProvider>>;
  /** `pull_requests` writes (list sync + diff-stat backfill) — tests inject a fake. */
  pullRequestRepo?: PullRequestStore;
  /** Clock (epoch ms) for the PR-list sync coordinator's TTL/back-off — tests fake time. */
  prSyncClock?: () => number;
  /** PR/MR detail service (`GET /pulls/:id`) — tests inject one over fakes. */
  pullDetail?: PullDetail;
  /** Repositories use cases (add/list/refresh/remove + clone job) — tests inject a fake. */
  repoService?: RepoOperations;
  /** repo-intel facade (T1.1+) — tests inject mock RepoIntel implementations. */
  repoIntel?: RepoIntel;
  /** L04 blast service — tests inject a service over mocked deps. */
  blastService?: BlastService;
  /** PR Brief service — tests inject a service over mocked deps. */
  briefService?: BriefService;
  /** L06 eval slice — tests inject the whole seam over mocked deps. */
  evalService?: EvalServices;
  /** repo-intel T3 adapters — only the indexer pipeline reads these. */
  depgraph?: DepGraph;
  tokenizer?: Tokenizer;
  // ── multi-user server mode (T19) ──────────────────────────────────────────
  /** OIDC identity provider — tests inject `MockIdentityProvider`. */
  identityProvider?: IdentityProvider;
  /** Per-request principal resolver (both modes) — tests inject a fake. */
  principals?: PrincipalProvider;
  /** Append-only audit log — tests inject a recording fake. */
  audit?: AuditLog<AuditTx>;
  /** Wall clock for sessions/tokens/audit — tests inject a fixed clock. */
  clock?: Clock;
  /** Encrypted-secret row store (google mode) — tests inject an in-memory fake. */
  secretStore?: BatchSecretStore<SecretsTx>;
}

/** Q8 — which secret authenticates git network ops for each provider, and as whom. */
const GIT_CREDENTIALS: Readonly<
  Record<RepoProvider, { host: HostRepoRef['host']; secret: SecretKey; username: string }>
> = {
  github: { host: 'github.com', secret: 'GITHUB_TOKEN', username: 'x-access-token' },
  gitlab: { host: 'gitlab.com', secret: 'GITLAB_TOKEN', username: 'oauth2' },
};

/** The managed (Settings → API keys) secret names held by the encrypted store. */
const MANAGED_SECRET_KEYS: readonly SecretKey[] = Object.values(SECRET_KEY_BY_PROVIDER);

export class Container {
  readonly config: AppConfig;
  readonly db: Db;
  readonly secrets: SecretsProvider;
  readonly auth: AuthProvider;
  readonly jobs: JobRunner;
  readonly runBus: RunBus;

  private _git?: HostGitClient;
  private _github?: GitHubClient;
  /** The real GitLab client, cached together with the token it was built for. */
  private _gitlab?: { client: RestGitLabClient; token: string | null };
  private _gitlabTokenHealth?: GitLabTokenHealthService;
  private _gitlabToken?: GitLabTokenService<SettingsActor>;
  private _prComments?: PrComments;
  private _publishRepo?: PublishRepository;
  private _publishRunner?: PublishRunner;
  private _publishReconciler?: PublishReconciler;
  private _publishService?: PublishService;
  private _codeIndex?: HostCodeIndex;
  private _embedder?: Embedder;
  private llmCache = new Map<string, LLMProvider>();

  // Shared repositories for cross-cutting entities (agents, reviews/pulls,
  // runs). Constructed here, in the composition root, so consuming modules use
  // `container.agentsRepo` instead of reaching into another module's folder.
  private _agentsRepo?: AgentsRepository;
  private _skillsRepo?: SkillsRepository;
  private _reviewRepo?: ReviewRepository;
  private _pullRequestRepo?: PullRequestRepository;
  private _pullsReadRepo?: PullsReadRepository;
  private _settingsRepo?: SettingsRepository;
  private _settingsService?: SettingsService<SettingsTx>;
  private _prSync?: PrSyncCoordinator<SyncRepo>;
  private _pullDetail?: PullDetail;
  private _pullList?: PullListService;
  private _repoService?: RepoOperations;
  private _repoIntel?: RepoIntel;
  private _intent?: IntentDeriver;
  private _smartDiffService?: SmartDiffService;
  private _blastService?: BlastService;
  private _briefService?: BriefService;
  private _evalServices?: EvalServices;
  private _depgraph?: DepGraph;
  private _tokenizer?: Tokenizer;
  private _priceBook?: PriceBook;
  private _identityRepo?: IdentityRepository;
  private _audit?: AuditLog<AuditTx>;
  private _secretStore?: BatchSecretStore<SecretsTx>;
  private _identityProvider?: IdentityProvider;
  private _principals?: PrincipalProvider;
  private _signIn?: SignInService;
  private _members?: MembersService;
  private _tokens?: TokensService;
  private _clock?: Clock;

  /**
   * @param log process-level logger for DETACHED work that has no request to log
   *   against (the PR-list sync). Structural — bootstrap passes Fastify's root
   *   logger (pino satisfies it); omitted ⇒ such failures are only persisted.
   */
  constructor(
    config: AppConfig,
    db: Db,
    private overrides: ContainerOverrides = {},
    private readonly log?: SyncLogger,
  ) {
    this.config = config;
    this.db = db;
    // `auth` resolves the seeded system user + the default (team) workspace in
    // BOTH modes: in google mode the per-request identity comes from
    // `principals`, while `auth.currentWorkspace()` still names the single team
    // workspace (encrypted-secret AAD, CLI, sign-in admission).
    this.auth = overrides.auth ?? new LocalNoAuthProvider(db);
    this.secrets = overrides.secrets ?? this.buildSecrets();
    this.runBus = runBus;
    this.jobs = new JobRunner(db, { log: this.log?.child?.({ module: 'jobs' }) ?? this.log });
  }

  /**
   * Mode switch for secrets: `local` keeps the plaintext 0600 JSON file with
   * the env fallback (unchanged); `google` reads managed keys ONLY from the
   * encrypted store (never `process.env`, AC-39), scoped to the team workspace.
   */
  private buildSecrets(): SecretsProvider {
    if (this.config.authMode !== 'google') return new LocalSecretsProvider(this.config.secretsPath);
    return new EncryptedSecretsProvider({
      store: this.secretStore,
      masterKey: this.requireMasterKey(),
      workspaceId: () => this.teamWorkspaceId(),
      managedKeys: MANAGED_SECRET_KEYS,
    });
  }

  private requireMasterKey(): Buffer {
    if (!this.config.masterKey) throw new ConfigError('SECRETS_MASTER_KEY is required when AUTH_MODE=google');
    return this.config.masterKey;
  }

  /** The single team workspace (default workspace, by name) — cached by `auth`. */
  async teamWorkspaceId(): Promise<string> {
    return (await this.auth.currentWorkspace({})).id;
  }

  /** System wall clock unless a test injects one. */
  get clock(): Clock {
    if (this.overrides.clock) return this.overrides.clock;
    return (this._clock ??= { now: () => new Date() });
  }

  /** Users, memberships, sessions, OIDC flows, API tokens (both modes). */
  get identityRepo(): IdentityRepository {
    return (this._identityRepo ??= new IdentityRepository(this.db));
  }

  /** Batch actor-name lookup for DTO enrichment (Rec-3). */
  get actorDirectory(): ActorDirectory {
    return this.identityRepo;
  }

  /** Append-only audit log (`audit_events`). */
  get audit(): AuditLog<AuditTx> {
    if (this.overrides.audit) return this.overrides.audit;
    return (this._audit ??= new AuditRepository(this.db));
  }

  /** Encrypted-secret rows (`encrypted_secrets`); used by google-mode secrets + the import CLI. */
  get secretStore(): BatchSecretStore<SecretsTx> {
    if (this.overrides.secretStore) return this.overrides.secretStore;
    return (this._secretStore ??= new SecretStoreRepository(this.db));
  }

  /**
   * Per-key secret state (AC-38) in both modes. Both real providers implement
   * `status()`; an injected test provider that doesn't is inspected via `get`.
   */
  get secretsInspector(): SecretsInspector {
    const secrets = this.secrets as SecretsProvider & Partial<SecretsInspector>;
    if (typeof secrets.status === 'function') return { status: secrets.status.bind(secrets) };
    return {
      status: async (keys) => {
        const out = new Map<SecretKey, SecretKeyStatus>();
        for (const key of keys) {
          const value = await secrets.get(key);
          out.set(key, { state: value ? 'set' : 'unset', updatedAt: null, updatedBy: null });
        }
        return out;
      },
    };
  }

  /**
   * Secret writes with attribution. Google mode records the acting user on the
   * encrypted row; local mode persists to the JSON file (no actor column).
   * Callers still call `invalidateSecretCaches()` after a write.
   */
  get secretsWriter(): SecretsWriter {
    const secrets = this.secrets;
    if (secrets instanceof EncryptedSecretsProvider) {
      return { set: (key, value, actorUserId) => secrets.set(key, value, actorUserId) };
    }
    return {
      set: async (key, value) => {
        if (!secrets.set) throw new ConfigError('The secrets backend is read-only');
        await secrets.set(key, value);
      },
    };
  }

  /**
   * Boot-time secrets maintenance (google mode only): rotation re-encrypt,
   * undecryptable scan, ignored-env warning. Takes the boot logger (pino fits
   * `SecretsLogger`); only env var NAMES are inspected.
   */
  secretsMaintenance(log: SecretsLogger): SecretsMaintenance<SecretsTx> {
    if (this.config.authMode !== 'google') {
      throw new ConfigError('Secrets maintenance runs only when AUTH_MODE=google');
    }
    return new SecretsMaintenance<SecretsTx>({
      store: this.secretStore,
      audit: this.audit,
      masterKey: this.requireMasterKey(),
      previousKey: this.config.previousMasterKey,
      managedKeys: MANAGED_SECRET_KEYS,
      env: process.env,
      log,
    });
  }

  /** Google OIDC client (google mode); tests inject `MockIdentityProvider`. */
  get identityProvider(): IdentityProvider {
    if (this.overrides.identityProvider) return this.overrides.identityProvider;
    if (!this._identityProvider) {
      const { google, publicApiBase, allowedDomain } = this.config;
      if (this.config.authMode !== 'google' || !google || !publicApiBase || !allowedDomain) {
        throw new ConfigError('Google sign-in is disabled (AUTH_MODE=local)');
      }
      this._identityProvider = new GoogleIdentityProvider({
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        redirectUri: `${publicApiBase}/auth/google/callback`,
        hostedDomain: allowedDomain,
      });
    }
    return this._identityProvider;
  }

  /**
   * Who is calling. Google mode: session cookie / bearer token, re-read on
   * every request (`PrincipalService`). Local mode: always the seeded system
   * user in the default workspace as Admin (`via: 'local'`), through `auth`.
   */
  get principals(): PrincipalProvider {
    if (this.overrides.principals) return this.overrides.principals;
    if (!this._principals) {
      if (this.config.authMode === 'google') {
        this._principals = new PrincipalService({ repo: this.identityRepo, clock: this.clock });
      } else {
        const auth = this.auth;
        this._principals = {
          resolve: async (req) => {
            const [user, workspace] = await Promise.all([
              auth.currentUser(req),
              auth.currentWorkspace(req),
            ]);
            return { userId: user.id, workspaceId: workspace.id, role: 'admin', via: 'local' };
          },
        };
      }
    }
    return this._principals;
  }

  /**
   * Google sign-in flow (google mode only). Async because the service is bound
   * to the team workspace id, resolved from the DB once.
   */
  async signIn(): Promise<SignInService> {
    if (this._signIn) return this._signIn;
    const { allowedDomain, adminEmails } = this.config;
    if (this.config.authMode !== 'google' || !allowedDomain) {
      throw new ConfigError('Google sign-in is disabled (AUTH_MODE=local)');
    }
    const idp = this.identityProvider;
    const id = await this.teamWorkspaceId();
    this._signIn ??= new SignInService({
      repo: this.identityRepo,
      idp,
      audit: this.audit,
      clock: this.clock,
      config: { allowedDomain, adminEmails },
      workspace: { id },
    });
    return this._signIn;
  }

  /** Members list / role + status changes (last-admin guard). */
  get members(): MembersService {
    return (this._members ??= new MembersService({
      identity: this.identityRepo,
      audit: this.audit,
      clock: this.clock,
    }));
  }

  /** Personal API tokens (create / list / revoke). */
  get tokens(): TokensService {
    return (this._tokens ??= new TokensService({
      identity: this.identityRepo,
      audit: this.audit,
      clock: this.clock,
    }));
  }

  get git(): HostGitClient {
    if (this.overrides.git) return this.overrides.git;
    const credentials: GitCredentialResolver = (ref) => this.gitCredential(ref);
    this._git ??= new SimpleGitClient(this.config.cloneDir, { credentials });
    return this._git;
  }

  /**
   * Q8 — per-invocation git credential for one network op. Each provider's
   * token is scoped to its OWN host (the adapter sends it as a host-scoped
   * `http.extraHeader`), and is never handed to the other provider. Read through
   * SecretsProvider on EVERY call (not cached) so a rotated/removed token takes
   * effect on the next clone/fetch. A missing secret ⇒ `null` (anonymous).
   *
   * GitLab: a configured token must pass the scope-health gate first — a token
   * known to lack `api` blocks the clone/fetch with
   * `gitlab_token_insufficient_scope` instead of falling back to anonymous
   * access (spec 2026-10-20 AC-23).
   */
  async gitCredential(ref: HostRepoRef): Promise<GitCredential | null> {
    const spec = GIT_CREDENTIALS[ref.provider];
    if (!spec || ref.host !== spec.host) return null;
    if (ref.provider === 'gitlab') {
      const usable = await this.gitlabTokenHealth.ensureUsable();
      return usable ? { username: spec.username, token: usable.token } : null;
    }
    const token = await this.secrets.get(spec.secret);
    return token ? { username: spec.username, token } : null;
  }

  get agentsRepo(): AgentsRepository {
    return (this._agentsRepo ??= new AgentsRepository(this.db));
  }

  /** Workspace prefs (key/value rows): settings routes + per-feature model resolution. */
  get settingsRepo(): SettingsRepository {
    return (this._settingsRepo ??= new SettingsRepository(this.db));
  }

  /**
   * Audited settings writes (`settings.update`, `secret.save`): each audit row
   * commits in the transaction of its write. The encrypted path is used only
   * when `secrets` is the provider built here over `secretStore` (an injected
   * `secrets` override may sit on a different backend → plain writer path).
   */
  get settingsService(): SettingsService<SettingsTx> {
    if (!this._settingsService) {
      const secrets = this.secrets;
      const encrypted =
        !this.overrides.secrets && secrets instanceof EncryptedSecretsProvider
          ? {
              prepareWrite: (key: SecretKey, value: string, actorUserId: string | null) =>
                secrets.prepareWrite(key, value, actorUserId),
              store: this.secretStore,
            }
          : null;
      this._settingsService = new SettingsService<SettingsTx>({
        settings: this.settingsRepo,
        audit: this.audit,
        secretsWriter: this.secretsWriter,
        encryptedSecrets: encrypted,
      });
    }
    return this._settingsService;
  }

  /**
   * GitLab token scope health (spec 2026-10-20 AC-23/24/28/29) — ONE per
   * container (= per API process): its in-memory health map and single-flight
   * checks are the gate in front of every GitLab operation. Keyed by a token
   * fingerprint, so `invalidateSecretCaches()` deliberately leaves it intact.
   */
  get gitlabTokenHealth(): GitLabTokenHealthService {
    return (this._gitlabTokenHealth ??= new GitLabTokenHealthService({
      readToken: () => this.readGitLabToken(),
      check: (token) => this.checkGitLabScopes(token),
    }));
  }

  /**
   * GitLab token save / test (AC-21/22/28): the candidate's scopes are probed
   * before anything is stored; a stored key goes through `SettingsService`, so
   * its `secret.save` audit row commits with the write (never for a rejected key).
   */
  get gitlabToken(): GitLabTokenService<SettingsActor> {
    return (this._gitlabToken ??= new GitLabTokenService<SettingsActor>({
      probe: (token) => this.checkGitLabScopes(token),
      readToken: () => this.readGitLabToken(),
      saveToken: (token, actor) => this.settingsService.saveSecret(actor, 'GITLAB_TOKEN', token),
      invalidateCaches: () => this.invalidateSecretCaches(),
      health: this.gitlabTokenHealth,
    }));
  }

  private async readGitLabToken(): Promise<string | null> {
    return (await this.secrets.get('GITLAB_TOKEN')) || null;
  }

  /**
   * One scope lookup for `token` on a token-specific client (never the cached
   * one, which may hold another token). Offline mode answers `unverified`
   * without a request (hosts are unreachable by configuration).
   */
  private async checkGitLabScopes(token: string): Promise<GitLabScopeCheck> {
    if (this.overrides.gitlab) return this.overrides.gitlab.checkTokenScopes();
    if (this.config.hostsOffline) return { kind: 'unverified' };
    return new RestGitLabClient({ token, fetch: this.overrides.gitlabFetch }).checkTokenScopes();
  }

  /**
   * L02 — narrow cross-module access to skills (run-executor resolves an
   * agent's linked skills via `resolveAgentSkills(agentId)` here rather than
   * importing the skills module's folder).
   */
  get skillsRepo(): SkillsRepository {
    return (this._skillsRepo ??= new SkillsRepository(this.db));
  }

  get reviewRepo(): ReviewRepository {
    return (this._reviewRepo ??= new ReviewRepository(this.db));
  }

  /** F1 — PR-list writes shared by the pulls and polling modules. */
  get pullRequestRepo(): PullRequestStore {
    if (this.overrides.pullRequestRepo) return this.overrides.pullRequestRepo;
    return (this._pullRequestRepo ??= new PullRequestRepository(this.db));
  }

  /** Read side of the pulls + polling routes (repo lookup, list rows, rollup inputs). */
  get pullsReadRepo(): PullsReadRepository {
    return (this._pullsReadRepo ??= new PullsReadRepository(this.db));
  }

  /**
   * PR-list sync-on-open coordinator — ONE per container (= one per API
   * process): its in-memory in-flight map IS the single-flight guarantee, so a
   * second instance would be a second lock. Each sync runs against the repo's
   * OWN provider host (AC-27), detached from the request that triggered it
   * (AC-64). Not routed through JobRunner: its retries/timeouts and persisted
   * job rows conflict with single-flight + TTL semantics.
   */
  get prSync(): PrSyncCoordinator<SyncRepo> {
    if (!this._prSync) {
      // One module-tagged child for all detached PR-sync logging (no request
      // logger exists for it); falls back to the bare logger when it has no `child`.
      const log = this.log?.child?.({ module: 'pr-sync' }) ?? this.log;
      const sync = new PrListSyncService({
        hosts: (provider) => this.prHost(provider),
        store: this.pullRequestRepo,
        log,
      });
      this._prSync = new PrSyncCoordinator<SyncRepo>({
        ttlMs: this.config.prSyncTtlMs,
        backoffMs: this.config.prSyncTtlMs,
        now: this.overrides.prSyncClock ?? (() => Date.now()),
        status: new SyncStatusRepository(this.db),
        run: (repo) => sync.syncRepo(repo),
        // The coordinator and the sync service both pass every error through
        // the redacting `describeSyncError` before it reaches this logger.
        log,
      });
    }
    return this._prSync;
  }

  /**
   * PR/MR detail (`GET /pulls/:id`) — the only place diffs/patches/commits are
   * fetched from a host. Stateless, so one per container; the request logger is
   * passed per call.
   */
  /** PR-list read model (persisted rows + review rollups) for the pulls routes. */
  get pullList(): PullListService {
    return (this._pullList ??= new PullListService(this.pullsReadRepo));
  }

  get pullDetail(): PullDetail {
    if (this.overrides.pullDetail) return this.overrides.pullDetail;
    return (this._pullDetail ??= new PullDetailService({
      hosts: (provider) => this.prHost(provider),
      store: this.pullRequestRepo,
    }));
  }

  /**
   * PR/MR inline comments (`GET`/`POST /pulls/:id/comments`, both hosts) over an
   * explicit deps object. GitLab access goes through the token-health gate and
   * resolves to the diff-discussion port (`GitLabCommentsHost`) plus the service
   * account the token authenticates as. Google mode adds the attribution footer
   * on GitLab posts (AC-16); local mode never does (AC-17).
   */
  get prComments(): PrComments {
    if (this.overrides.prComments) return this.overrides.prComments;
    return (this._prComments ??= new PrCommentsService({
      github: () => this.github(),
      gitlabAccess: {
        resolve: async () => {
          const { client, usable } = await this.resolveGitLab();
          return usable ? { host: client, serviceAccount: usable.username } : null;
        },
      },
      files: async (prId) => (await this.pullRequestRepo.getPersistedDetail(prId)).files,
      actorName: (userId) => this.identityRepo.displayIdentity(userId),
      footerEnabled: this.config.authMode === 'google',
    }));
  }

  // ── Publish findings to GitLab (spec 2026-10-21-gitlab-publish-findings) ──

  /** Publications + items (the only SQL of the publish slice). */
  get publishRepo(): PublishRepository {
    return (this._publishRepo ??= new PublishRepository(this.db));
  }

  /**
   * The GitLab access of the publish flow: the same token-health gate as the
   * comments use case (`resolveGitLab`), resolved to the draft-review port plus
   * the service account the token authenticates as. One GitLab token per
   * deployment (the team workspace's), so every workspace resolves the same way.
   * Offline mode rejects with `ConfigError` before any token read (e2e).
   */
  private get publishGitLabAccess(): PublishGitLabAccess {
    return {
      resolve: async () => {
        const { client, usable } = await this.resolveGitLab();
        return usable ? { host: client, serviceAccount: usable.username } : null;
      },
    };
  }

  /** google mode only (AC-41); local mode records no audit events (AC-42). */
  private get publishAudit(): PublishAudit {
    return this.config.authMode === 'google' ? this.audit : null;
  }

  /** Detached-work logger (codes and ids only); `error` falls back to `warn`. */
  private get publishLog(): PublishLogger {
    const base = (this.log?.child?.({ module: 'publish' }) ?? this.log) as
      | (SyncLogger & { error?: (obj: unknown, msg?: string) => void })
      | undefined;
    return {
      warn: (obj, msg) => base?.warn(obj, msg),
      error: (obj, msg) => (base?.error ? base.error(obj, msg) : base?.warn(obj, msg)),
    };
  }

  /**
   * In-process background publications — a SINGLETON: its live-task map is
   * what the reconciler consults (`isActive`) and what shutdown awaits. Not
   * `JobRunner` (its retries would re-send non-idempotent writes; plan Rec1).
   */
  get publishRunner(): PublishRunner {
    if (!this._publishRunner) {
      const log = this.publishLog;
      this._publishRunner = new PublishRunner({
        executor: new PublishExecutor({
          store: this.publishRepo,
          audit: this.publishAudit,
          clock: this.clock,
          log,
        }),
        log,
      });
    }
    return this._publishRunner;
  }

  /** Read-only settling of stale / unconfirmed publications (AC-32 – AC-34); single-flight. */
  get publishReconciler(): PublishReconciler {
    return (this._publishReconciler ??= new PublishReconciler({
      store: this.publishRepo,
      accessFor: () => this.publishGitLabAccess,
      runner: this.publishRunner,
      audit: this.publishAudit,
      clock: this.clock,
      log: this.publishLog,
    }));
  }

  /**
   * The synchronous half of publishing (preview, other-drafts count, create →
   * 202, reads). Footer in google mode only (AC-42); token health is read
   * from the gate's in-memory state (no GitLab call, AC-2).
   */
  get publishService(): PublishService {
    if (this.overrides.publishService) return this.overrides.publishService;
    return (this._publishService ??= new PublishService({
      store: this.publishRepo,
      gitlab: this.publishGitLabAccess,
      tokenHealth: () => this.gitlabTokenHealth.current(),
      actorName: (userId) => this.identityRepo.displayIdentity(userId),
      footerEnabled: this.config.authMode === 'google',
      runner: this.publishRunner,
      reconciler: this.publishReconciler,
      clock: this.clock,
      log: this.publishLog,
    }));
  }

  /**
   * F1 — Repositories service over an EXPLICIT deps object (never the
   * Container). Adapters that depend on secrets resolve lazily per call; the
   * repo-intel follow-up job kinds are bound here so the repos slice never
   * imports a sibling module's folder.
   */
  get repoService(): RepoOperations {
    if (this.overrides.repoService) return this.overrides.repoService;
    return (this._repoService ??= new RepoService({
      repo: new RepoRepository(this.db),
      git: this.git,
      jobs: this.jobs,
      gitlab: () => this.gitlab(),
      syncStatus: { isRunning: (repoId) => this.prSync.isRunning(repoId) },
      followUpJobs: { index: INDEX_JOB_KIND, refresh: REFRESH_JOB_KIND },
    }));
  }

  get codeIndex(): HostCodeIndex {
    if (this.overrides.codeIndex) return this.overrides.codeIndex;
    this._codeIndex ??= new RipgrepCodeIndex(this.git);
    return this._codeIndex;
  }

  /**
   * The repo-intel facade (T1.1). All higher-level features (reviews,
   * blast/onboarding migrations, phantom-gate) code against this interface.
   * Tests inject a mock via `ContainerOverrides.repoIntel`.
   */
  get repoIntel(): RepoIntel {
    if (this.overrides.repoIntel) return this.overrides.repoIntel;
    this._repoIntel ??= new RepoIntelService(this);
    return this._repoIntel;
  }

  /**
   * L03 — Intent Layer derivation: the free functions of
   * reviews/intent-deriver.ts bound over an EXPLICIT deps object (not the
   * Container itself), so the derivation stays in the application ring;
   * adapters resolve lazily per call. The intent routes AND the reviews
   * executor consume the binding here (no sibling-module imports).
   */
  get intent(): IntentDeriver {
    this._intent ??= createIntentDeriver({
      repo: this.reviewRepo,
      github: () => this.github(),
      prHost: (provider) => this.prHost(provider),
      git: this.git,
      llm: (id) => this.llm(id),
      resolveModel: (workspaceId) => resolveFeatureModel(this, workspaceId, 'review_intent'),
    });
    return this._intent;
  }

  /**
   * L0x — Smart Diff service (risk-ordered PR files, computed on read; no
   * LLM). Explicit deps object; cross-module review data flows through the
   * shared reviewRepo, never a sibling module's folder.
   */
  get smartDiffService(): SmartDiffService {
    this._smartDiffService ??= new SmartDiffService({ repo: this.reviewRepo });
    return this._smartDiffService;
  }

  /**
   * L04 — Blast Radius service (symbols → callers → endpoints/crons, computed
   * on read from the repo-intel persistent index; no LLM, no persistence).
   * Explicit deps object; PR data flows through the shared reviewRepo and the
   * repo-intel facade, never a sibling module's folder.
   */
  get blastService(): BlastService {
    if (this.overrides.blastService) return this.overrides.blastService;
    this._blastService ??= new BlastService({
      repoIntelEnabled: this.config.repoIntelEnabled,
      repoIntel: this.repoIntel,
      repo: this.reviewRepo,
      blastRepo: new BlastRepository(this.db),
    });
    return this._blastService;
  }

  /**
   * PR Brief service — "why this PR exists and what could break", cached per PR
   * and regenerated on demand with exactly ONE structured model call.
   *
   * Explicit deps object, never the `Container`: the cross-module inputs
   * (intent, blast, PR/review rows) arrive as bindings wired here, so the brief
   * slice never imports a sibling module's folder. `risk_brief` is the feature
   * model key resolved per workspace (Rec-5).
   */
  get briefService(): BriefService {
    if (this.overrides.briefService) return this.overrides.briefService;
    this._briefService ??= new BriefService({
      repo: this.reviewRepo,
      briefRepo: new BriefRepository(this.db),
      intent: this.intent,
      blast: this.blastService,
      github: () => this.github(),
      prHost: (provider) => this.prHost(provider),
      git: this.git,
      llm: (id) => this.llm(id),
      resolveModel: (workspaceId) => resolveFeatureModel(this, workspaceId, 'risk_brief'),
    });
    return this._briefService;
  }

  /**
   * L06 Eval Pipeline — the regression harness (spec `specs/06-eval-pipeline.md`).
   *
   * ONE `EvalRepository` is shared by all three application objects so a batch
   * write and the read that aggregates it can never sit on two different
   * connections' views. The runner is a SINGLETON on purpose: its in-flight
   * `Set<agentId>` is the "one batch per agent" lock (AC-19), and a second
   * instance would be a second lock, i.e. no lock at all — which is also why
   * both the dashboard's `run-all` and the case service's single-case run take
   * THIS runner rather than building their own.
   *
   * Explicit deps objects, never the `Container`: the slice's cross-module
   * inputs (agents, agent versions, skills, findings → reviews → PRs → patches)
   * arrive as bindings wired here, so `modules/eval/` never imports a sibling
   * module's folder (onion §9).
   */
  get evalService(): EvalServices {
    if (this.overrides.evalService) return this.overrides.evalService;
    if (!this._evalServices) {
      const evalRepo = new EvalRepository(this.db);
      const runner = new EvalRunner({
        evalRepo,
        agentsRepo: this.agentsRepo,
        skillsRepo: this.skillsRepo,
        llm: (id) => this.llm(id),
      });
      this._evalServices = {
        runner,
        dashboard: new EvalDashboardService({ evalRepo, agentsRepo: this.agentsRepo, runner }),
        cases: new EvalService({
          evalRepo,
          reviewRepo: this.reviewRepo,
          agentsRepo: this.agentsRepo,
          runner,
        }),
      };
    }
    return this._evalServices;
  }

  /** Import-graph builder (dependency-cruiser). T3 indexer pipeline only. */
  get depgraph(): DepGraph {
    if (this.overrides.depgraph) return this.overrides.depgraph;
    this._depgraph ??= new DepCruiseGraph();
    return this._depgraph;
  }

  /** Token counter (js-tiktoken) for the repo-map budget search. */
  get tokenizer(): Tokenizer {
    if (this.overrides.tokenizer) return this.overrides.tokenizer;
    this._tokenizer ??= new TiktokenTokenizer();
    return this._tokenizer;
  }

  /**
   * Live OpenRouter pricing for cost attribution. The lister builds a bare
   * OpenRouter provider just for `/models` (no estimator needed) and degrades to
   * `[]` when no key is configured; the static `estimateCost` table is the
   * fallback for OpenAI/Anthropic and a cold/cold-failed cache.
   */
  get priceBook(): PriceBook {
    this._priceBook ??= new PriceBook(async () => {
      try {
        const key = await this.secrets.get('OPENROUTER_API_KEY');
        if (!key) return [];
        return await new OpenRouterProvider(key).listModels();
      } catch {
        return [];
      }
    }, estimateCost);
    return this._priceBook;
  }

  async github(): Promise<GitHubClient> {
    if (this.overrides.github) return this.overrides.github;
    if (this._github) return this._github;
    const token = await this.secrets.get('GITHUB_TOKEN');
    if (!token) throw new ConfigError('GITHUB_TOKEN is not configured');
    this._github = new OctokitGitHubClient(
      token,
      this.overrides.githubFetch ? { fetch: this.overrides.githubFetch } : {},
    );
    return this._github;
  }

  /**
   * gitlab.com client. The token is OPTIONAL (anonymous access works for public
   * projects); only `GITLAB_TOKEN` is ever read here — never `GITHUB_TOKEN`
   * (AC-13). Offline mode rejects before any client is built or token read.
   *
   * A configured token must pass the scope-health gate first (spec 2026-10-20
   * AC-23/24): a token known to lack `api` rejects with
   * `gitlab_token_insufficient_scope` — never an anonymous fallback.
   */
  async gitlab(): Promise<GitLabClient> {
    return (await this.resolveGitLab()).client;
  }

  /** The same gated client, typed by the diff-discussion port (comments). */
  async gitlabComments(): Promise<GitLabCommentsHost> {
    return (await this.resolveGitLab()).client;
  }

  /**
   * Offline check → token gate (one secret read) → client. The real client is
   * cached per token value and reports 401 / 403 `insufficient_scope`
   * responses back to the health gate (`onAuthFailure`, AC-24/29).
   */
  private async resolveGitLab(): Promise<{
    client: GitLabClient & GitLabCommentsHost & GitLabDraftNotesHost & GitLabDiffVersionsHost;
    usable: UsableGitLabToken | null;
  }> {
    if (this.config.hostsOffline) {
      throw new ConfigError('Repository hosts are offline (DEVDIGEST_HOSTS_OFFLINE=true)');
    }
    const usable = await this.gitlabTokenHealth.ensureUsable();
    if (this.overrides.gitlab) return { client: this.overrides.gitlab, usable };
    const token = usable?.token ?? null;
    if (!this._gitlab || this._gitlab.token !== token) {
      const health = this.gitlabTokenHealth;
      this._gitlab = {
        token,
        client: new RestGitLabClient({
          token,
          fetch: this.overrides.gitlabFetch,
          ...(token ? { onAuthFailure: (kind) => health.reportAuthFailure(token, kind) } : {}),
        }),
      };
    }
    return { client: this._gitlab.client, usable };
  }

  /**
   * Provider-neutral read-side host. A missing `GITHUB_TOKEN` rejects only the
   * GitHub host — GitLab still resolves (AC-27).
   */
  async prHost(provider: RepoProvider): Promise<PullRequestHost> {
    if (this.config.hostsOffline) {
      throw new ConfigError('Repository hosts are offline (DEVDIGEST_HOSTS_OFFLINE=true)');
    }
    if (provider === 'gitlab') return this.gitlab();
    return new GitHubPullRequestHost(await this.github());
  }

  /** Resolve an LLM provider by id; constructs from the secret key, cached. */
  async llm(id: 'openai' | 'anthropic' | 'openrouter'): Promise<LLMProvider> {
    const injected = this.overrides.llm?.[id];
    if (injected) return injected;
    const cached = this.llmCache.get(id);
    if (cached) return cached;
    const provider = await this.buildLlm(id);
    this.llmCache.set(id, provider);
    return provider;
  }

  private async buildLlm(id: 'openai' | 'anthropic' | 'openrouter'): Promise<LLMProvider> {
    if (id === 'openai') {
      const key = await this.secrets.get('OPENAI_API_KEY');
      if (!key) throw new ConfigError('OPENAI_API_KEY is not configured');
      return new OpenAIProvider(key);
    }
    if (id === 'openrouter') {
      // Single OpenRouter provider lives in reviewer-core (shared with the CI
      // runner); inject the PriceBook so cost attribution uses LIVE OpenRouter
      // prices (with the static table as a fallback) rather than a hardcoded one.
      const key = await this.secrets.get('OPENROUTER_API_KEY');
      if (!key) throw new ConfigError('OPENROUTER_API_KEY is not configured');
      return new OpenRouterProvider(key, {
        estimateCost: (model, tokensIn, tokensOut) =>
          this.priceBook.estimate(model, tokensIn, tokensOut),
      });
    }
    const key = await this.secrets.get('ANTHROPIC_API_KEY');
    if (!key) throw new ConfigError('ANTHROPIC_API_KEY is not configured');
    return new AnthropicProvider(key);
  }

  async embedder(): Promise<Embedder> {
    // Injected embedders (tests) always win. Otherwise embeddings are gated by
    // config: when disabled we throw BEFORE constructing the OpenAI client, so
    // the app makes ZERO OpenAI requests. All callers wrap this in try/catch and
    // degrade gracefully (memory/RAG simply returns no hits).
    if (this.overrides.embedder) return this.overrides.embedder;
    if (!this.config.embeddingsEnabled) {
      throw new ConfigError('Embeddings are disabled (set EMBEDDINGS_ENABLED=true to enable memory/RAG)');
    }
    if (this._embedder) return this._embedder;
    const openai = await this.llm('openai');
    this._embedder = new OpenAIEmbedder(openai);
    return this._embedder;
  }

  /**
   * Drop cached provider clients so the next resolve picks up changed secrets.
   * Call after persisting a new API key/PAT via SecretsProvider.set.
   */
  invalidateSecretCaches(): void {
    this.llmCache.clear();
    this._github = undefined;
    this._gitlab = undefined;
    this._embedder = undefined;
  }
}
