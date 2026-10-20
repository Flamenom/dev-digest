import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostRepoRef, SecretKey, SecretsProvider } from '@devdigest/shared';
import { Container } from '../src/platform/container.js';
import { loadConfig } from '../src/platform/config.js';
import type { Db } from '../src/db/client.js';
import { MockAuthProvider, MockGitHubClient, MockGitLabClient } from '../src/adapters/mocks.js';
import { RestGitLabClient } from '../src/adapters/gitlab/index.js';
import { GitHubPullRequestHost } from '../src/adapters/github/host.js';
import { fakeFetch, json, type FakeRequest } from './fixtures/gitlab/fake-fetch.js';

/**
 * T4 — composition-root wiring for repository hosts (hermetic: the db is never
 * touched by these getters, so a stub handle is enough).
 */

class RecordingSecrets implements SecretsProvider {
  readonly reads: string[] = [];
  constructor(public values: Partial<Record<string, string>> = {}) {}
  async get(key: SecretKey): Promise<string | undefined> {
    this.reads.push(key as string);
    return this.values[key as string];
  }
}

function makeContainer(opts: {
  secrets?: Partial<Record<string, string>>;
  offline?: boolean;
  overrides?: ConstructorParameters<typeof Container>[2];
} = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    ...(opts.offline ? { DEVDIGEST_HOSTS_OFFLINE: 'true' } : {}),
  } as NodeJS.ProcessEnv);
  const secrets = new RecordingSecrets(opts.secrets);
  const container = new Container(config, {} as Db, {
    secrets,
    auth: new MockAuthProvider(),
    ...opts.overrides,
  });
  return { container, secrets };
}

const apiPath = (r: FakeRequest) => r.url.pathname.replace('/api/v4', '');

/**
 * Fake gitlab.com over the `gitlabFetch` override: the scope probe answers with
 * `scopes`, `GET /projects/:path` with a project, anything else 404.
 */
function fakeGitLab(scopes: string[] = ['api'], user: () => Response = () => json({ username: 'devdigest-bot' })) {
  return fakeFetch((req) => {
    const p = apiPath(req);
    if (p === '/user') return user();
    if (p === '/personal_access_tokens/self') return json({ scopes });
    if (p.startsWith('/projects/')) {
      return json({ id: 1, path_with_namespace: 'g/p', default_branch: 'main', web_url: 'https://gitlab.com/g/p' });
    }
    return json({ message: '404 Not Found' }, 404);
  });
}

const GITLAB_REF: HostRepoRef = {
  provider: 'gitlab',
  host: 'gitlab.com',
  owner: 'group/sub',
  name: 'proj',
  fullName: 'group/sub/proj',
};
const GITHUB_REF: HostRepoRef = {
  provider: 'github',
  host: 'github.com',
  owner: 'acme',
  name: 'api',
  fullName: 'acme/api',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('config.hostsOffline', () => {
  it('is false by default and true only for DEVDIGEST_HOSTS_OFFLINE=true', () => {
    expect(loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv).hostsOffline).toBe(false);
    expect(
      loadConfig({ NODE_ENV: 'test', DEVDIGEST_HOSTS_OFFLINE: 'true' } as NodeJS.ProcessEnv)
        .hostsOffline,
    ).toBe(true);
  });
});

describe('Container hosts', () => {
  it("prHost('gitlab') with no token builds an anonymous client and never reads GITHUB_TOKEN", async () => {
    const { container, secrets } = makeContainer();
    const host = await container.prHost('gitlab');
    expect(host).toBeInstanceOf(RestGitLabClient);
    expect(host.provider).toBe('gitlab');
    // GitLab is writable since comment posting (spec 2026-10-20).
    expect(host.readOnly).toBe(false);
    expect(secrets.reads).toEqual(['GITLAB_TOKEN']);
    expect(secrets.reads).not.toContain('GITHUB_TOKEN');

    // Anonymous: no auth header is sent.
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 1,
          path_with_namespace: 'group/sub/proj',
          default_branch: 'main',
          web_url: 'https://gitlab.com/group/sub/proj',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    await (host as RestGitLabClient).getProject('group/sub/proj');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = new Headers(init.headers);
    expect(headers.has('PRIVATE-TOKEN')).toBe(false);
    expect(headers.has('Authorization')).toBe(false);
  });

  it('gitlab() is cached and invalidateSecretCaches() rebuilds it with the new token', async () => {
    const gl = fakeGitLab();
    const { container, secrets } = makeContainer({ overrides: { gitlabFetch: gl.fetch } });
    const a = await container.gitlab();
    expect(await container.gitlab()).toBe(a);
    secrets.values.GITLAB_TOKEN = 'glpat-new';
    container.invalidateSecretCaches();
    const b = await container.gitlab();
    expect(b).not.toBe(a);
    // The new token was scope-checked once before the client was handed out (AC-24).
    expect(gl.calls.map(apiPath)).toEqual(['/user', '/personal_access_tokens/self']);

    await (b as RestGitLabClient).getProject('g/p');
    const last = gl.calls.at(-1)!;
    expect(apiPath(last)).toBe('/projects/g%2Fp');
    expect(last.headers['private-token']).toBe('glpat-new');
    expect(secrets.reads).not.toContain('GITHUB_TOKEN');
  });

  it('a changed token value rebuilds the client even without invalidateSecretCaches()', async () => {
    const gl = fakeGitLab();
    const { container, secrets } = makeContainer({
      secrets: { GITLAB_TOKEN: 'glpat-one' },
      overrides: { gitlabFetch: gl.fetch },
    });
    const a = await container.gitlab();
    secrets.values.GITLAB_TOKEN = 'glpat-two';
    const b = await container.gitlab();
    expect(b).not.toBe(a);
    await (b as RestGitLabClient).getProject('g/p');
    expect(gl.calls.at(-1)!.headers['private-token']).toBe('glpat-two');
  });

  it("prHost('github') without GITHUB_TOKEN rejects while prHost('gitlab') still resolves (AC-27)", async () => {
    const { container } = makeContainer();
    await expect(container.prHost('github')).rejects.toMatchObject({ code: 'config_error' });
    await expect(container.prHost('gitlab')).resolves.toBeInstanceOf(RestGitLabClient);
  });

  it("prHost('github') wraps the GitHub client as a writable host", async () => {
    const gh = new MockGitHubClient();
    const { container } = makeContainer({ overrides: { github: gh } });
    const host = await container.prHost('github');
    expect(host).toBeInstanceOf(GitHubPullRequestHost);
    expect(host.provider).toBe('github');
    expect(host.readOnly).toBe(false);
    expect(await host.getPullStates(GITHUB_REF, [1, 2])).toEqual([]);
    expect(await host.getIssue(GITHUB_REF, 1)).toBeNull();
    expect(await host.getLinkedIssueNumber(GITHUB_REF, 1)).toBeNull();
    expect(await host.listPullRequests(GITHUB_REF)).toEqual(
      await gh.listPullRequests(GITHUB_REF),
    );
    const pulls = await gh.listPullRequests(GITHUB_REF);
    if (pulls[0]) {
      const detail = await host.getPullRequestDetail(GITHUB_REF, pulls[0].number);
      expect(detail.kind).toBe('full');
    }
  });

  it('with hostsOffline both hosts reject with ConfigError and nothing is fetched or read', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { container, secrets } = makeContainer({
      offline: true,
      secrets: { GITHUB_TOKEN: 'ghp_x', GITLAB_TOKEN: 'glpat_x' },
    });
    await expect(container.prHost('github')).rejects.toMatchObject({ code: 'config_error' });
    await expect(container.prHost('gitlab')).rejects.toMatchObject({ code: 'config_error' });
    await expect(container.gitlab()).rejects.toMatchObject({ code: 'config_error' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(secrets.reads).toEqual([]);
  });

  it('an injected gitlab override wins (no token ⇒ only the gate read, no scope check)', async () => {
    const mock = new MockGitLabClient();
    const { container, secrets } = makeContainer({ overrides: { gitlab: mock } });
    expect(await container.prHost('gitlab')).toBe(mock);
    expect(await container.gitlab()).toBe(mock);
    expect(await container.gitlabComments()).toBe(mock);
    expect(secrets.reads.every((k) => k === 'GITLAB_TOKEN')).toBe(true);
    expect(mock.calls).toEqual([]);
  });
});

describe('Container GitLab token gate (spec 2026-10-20 AC-23/24/29)', () => {
  it('a token without `api` blocks gitlab(), prHost, comments and git credentials — 1 scope check, no anonymous fallback', async () => {
    const gl = fakeGitLab(['read_api', 'read_repository']);
    const { container } = makeContainer({
      secrets: { GITLAB_TOKEN: 'glpat-legacy' },
      overrides: { gitlabFetch: gl.fetch },
    });
    const blocked = { code: 'gitlab_token_insufficient_scope', statusCode: 400 };
    await expect(container.gitlab()).rejects.toMatchObject(blocked);
    await expect(container.prHost('gitlab')).rejects.toMatchObject(blocked);
    await expect(container.gitlabComments()).rejects.toMatchObject(blocked);
    await expect(container.gitCredential(GITLAB_REF)).rejects.toMatchObject(blocked);
    // Only the scope check itself reached GitLab, once (memoised per token value).
    expect(gl.calls.map(apiPath)).toEqual(['/user', '/personal_access_tokens/self']);
    expect(await container.gitlabTokenHealth.current()).toBe('insufficient_scope');
  });

  it('an `api` token passes the gate; GitHub credentials never touch it', async () => {
    const gl = fakeGitLab(['api']);
    const { container } = makeContainer({
      secrets: { GITLAB_TOKEN: 'glpat-api', GITHUB_TOKEN: 'ghp_x' },
      overrides: { gitlabFetch: gl.fetch },
    });
    expect(await container.gitCredential(GITLAB_REF)).toEqual({ username: 'oauth2', token: 'glpat-api' });
    expect(await container.gitCredential(GITHUB_REF)).toEqual({ username: 'x-access-token', token: 'ghp_x' });
    await container.gitlab();
    expect(gl.calls.map(apiPath)).toEqual(['/user', '/personal_access_tokens/self']);
    expect(await container.gitlabTokenHealth.current()).toBe('ok');
  });

  it('a live 401 from the client marks the token invalid (onAuthFailure is bound to the health gate)', async () => {
    let reject = false;
    const { fetch, calls } = fakeFetch((req) => {
      const p = apiPath(req);
      if (reject) return json({ message: '401 Unauthorized' }, 401);
      if (p === '/user') return json({ username: 'devdigest-bot' });
      if (p === '/personal_access_tokens/self') return json({ scopes: ['api'] });
      return json({ message: '404 Not Found' }, 404);
    });
    const { container } = makeContainer({
      secrets: { GITLAB_TOKEN: 'glpat-revoked-later' },
      overrides: { gitlabFetch: fetch },
    });
    const client = (await container.gitlab()) as RestGitLabClient;
    reject = true;
    await expect(client.getProject('g/p')).rejects.toBeDefined();
    expect(await container.gitlabTokenHealth.current()).toBe('invalid');
    expect(calls.length).toBeGreaterThan(2);
    // `invalid` re-checks on the next use (Q7) — the re-check now fails too.
    await expect(container.gitlab()).rejects.toMatchObject({ code: 'gitlab_token_invalid' });
  });

  it('prComments resolves GitLab access to the gated client + service account', async () => {
    const mock = new MockGitLabClient({
      scopeCheck: { kind: 'ok', username: 'svc-bot', scopes: ['api'] },
    });
    const { container } = makeContainer({
      secrets: { GITLAB_TOKEN: 'glpat-api' },
      overrides: { gitlab: mock },
    });
    const access = (container.prComments as unknown as {
      deps: { gitlabAccess: { resolve: () => Promise<{ host: unknown; serviceAccount: string } | null> } };
    }).deps.gitlabAccess;
    await expect(access.resolve()).resolves.toEqual({ host: mock, serviceAccount: 'svc-bot' });

    const noToken = makeContainer({ overrides: { gitlab: new MockGitLabClient() } });
    const none = (noToken.container.prComments as unknown as {
      deps: { gitlabAccess: { resolve: () => Promise<unknown> } };
    }).deps.gitlabAccess;
    await expect(none.resolve()).resolves.toBeNull();
  });

  it('offline mode: the gate never runs a scope lookup', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { container } = makeContainer({ offline: true, secrets: { GITLAB_TOKEN: 'glpat_x' } });
    await expect(container.gitlab()).rejects.toMatchObject({ code: 'config_error' });
    await expect(container.gitlabToken.testStored()).resolves.toMatchObject({
      ok: false,
      code: 'gitlab_token_unverified',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Container git credential resolver (Q8)', () => {
  // The GitLab token passes the scope gate through the mock's `checkTokenScopes` (ok/api).
  const gitlab = () => ({ gitlab: new MockGitLabClient() });

  it("returns each provider's own token, never the other's", async () => {
    const { container } = makeContainer({
      secrets: { GITHUB_TOKEN: 'ghp_github', GITLAB_TOKEN: 'glpat_gitlab' },
      overrides: gitlab(),
    });
    expect(await container.gitCredential(GITLAB_REF)).toEqual({
      username: 'oauth2',
      token: 'glpat_gitlab',
    });
    expect(await container.gitCredential(GITHUB_REF)).toEqual({
      username: 'x-access-token',
      token: 'ghp_github',
    });
  });

  it("returns null when that provider's secret is unset, even if the other's is set", async () => {
    const onlyGithub = makeContainer({ secrets: { GITHUB_TOKEN: 'ghp_github' } });
    expect(await onlyGithub.container.gitCredential(GITLAB_REF)).toBeNull();
    expect(onlyGithub.secrets.reads).toEqual(['GITLAB_TOKEN']);

    const onlyGitlab = makeContainer({ secrets: { GITLAB_TOKEN: 'glpat_gitlab' }, overrides: gitlab() });
    expect(await onlyGitlab.container.gitCredential(GITHUB_REF)).toBeNull();
    expect(onlyGitlab.secrets.reads).toEqual(['GITHUB_TOKEN']);
  });

  it('reads the secret on every call, so a rotated token applies immediately', async () => {
    const { container, secrets } = makeContainer({ secrets: { GITLAB_TOKEN: 'old' }, overrides: gitlab() });
    expect((await container.gitCredential(GITLAB_REF))?.token).toBe('old');
    secrets.values.GITLAB_TOKEN = 'new';
    expect((await container.gitCredential(GITLAB_REF))?.token).toBe('new');
    expect(secrets.reads).toEqual(['GITLAB_TOKEN', 'GITLAB_TOKEN']);
  });

  it('never sends a token for a ref whose host does not match its provider', async () => {
    const { container, secrets } = makeContainer({
      secrets: { GITHUB_TOKEN: 'ghp_github', GITLAB_TOKEN: 'glpat_gitlab' },
    });
    const mismatched = { ...GITLAB_REF, host: 'github.com' } as HostRepoRef;
    expect(await container.gitCredential(mismatched)).toBeNull();
    expect(secrets.reads).toEqual([]);
  });

  it('the git getter wires the resolver into SimpleGitClient', () => {
    const { container } = makeContainer();
    const git = container.git as unknown as { credentials?: (r: HostRepoRef) => unknown };
    expect(typeof git.credentials).toBe('function');
  });
});
