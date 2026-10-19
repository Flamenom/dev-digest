import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SimpleGit } from 'simple-git';
import type { GitCredential, HostRepoRef, RepoRef } from '@devdigest/shared';
import {
  SimpleGitClient,
  createSimpleGit,
  type GitEnv,
  type GitFactory,
} from '../src/adapters/git/simple-git.js';

/**
 * Q8 credential delivery, end to end against REAL git and local bare repos.
 * No network: a temp HOME/.gitconfig maps the canonical https URLs to local
 * `file://` bare repos via `url.<base>.insteadOf`, so the adapter sees (and
 * persists) the real https remote while git transports locally.
 */

const GH_TOKEN = 'gh-fixture-secret-111';
const GL_TOKEN = 'gl-fixture-secret-222';
const GH_URL = 'https://github.com/acme/web.git';
const GL_URL = 'https://gitlab.com/acme/web.git';

const b64 = (user: string, token: string) =>
  Buffer.from(`${user}:${token}`, 'utf8').toString('base64');
const GH_B64 = b64('x-access-token', GH_TOKEN);
const GL_B64 = b64('oauth2', GL_TOKEN);

const GH_REF: HostRepoRef = {
  owner: 'acme',
  name: 'web',
  fullName: 'acme/web',
  provider: 'github',
  host: 'github.com',
};
const GL_REF: HostRepoRef = { ...GH_REF, provider: 'gitlab', host: 'gitlab.com' };

let root: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TRACE', 'GIT_CURL_VERBOSE', 'GIT_TRACE_CURL'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function makeOrigin(name: string, extraRefs: string[]): Promise<string> {
  const work = join(root, `${name}-work`);
  const bare = join(root, `${name}.git`);
  await mkdir(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  await writeFile(join(work, 'README.md'), `# ${name}\n`);
  git(work, 'add', '.');
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(work, 'push', '-q', bare, 'main');
  for (const ref of extraRefs) git(work, 'push', '-q', bare, `HEAD:${ref}`);
  return bare;
}

interface Call {
  baseDir: string;
  env?: GitEnv;
  argv: string[][];
}

function spyFactory(calls: Call[], override?: (g: SimpleGit, baseDir: string) => SimpleGit): GitFactory {
  return (baseDir, env) => {
    const call: Call = { baseDir, env, argv: [] };
    calls.push(call);
    const g = createSimpleGit(baseDir, env).outputHandler((_cmd, _out, _err, args) => {
      call.argv.push([...args]);
    });
    return override ? override(g, baseDir) : g;
  };
}

function resolverSpy(seen: HostRepoRef[]) {
  return async (ref: HostRepoRef): Promise<GitCredential | null> => {
    seen.push(ref);
    return ref.provider === 'gitlab'
      ? { username: 'oauth2', token: GL_TOKEN }
      : { username: 'x-access-token', token: GH_TOKEN };
  };
}

const networkCalls = (calls: Call[]) =>
  calls.filter((c) => c.argv.some((a) => a[0] === 'clone' || a[0] === 'fetch'));

function expectNoSecretInArgv(calls: Call[]) {
  for (const c of calls) {
    for (const argv of c.argv) {
      for (const el of argv) {
        for (const s of [GH_TOKEN, GL_TOKEN, GH_B64, GL_B64]) expect(el).not.toContain(s);
      }
    }
  }
}

async function expectCleanConfig(clonePath: string) {
  const cfg = await readFile(join(clonePath, '.git', 'config'), 'utf8');
  for (const s of [GH_TOKEN, GL_TOKEN, GH_B64, GL_B64]) expect(cfg).not.toContain(s);
  expect(cfg).not.toMatch(/\/\/[^\s/@]+@/);
  expect(cfg.toLowerCase()).not.toContain('extraheader');
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dd-git-cred-'));
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  delete process.env.GIT_CONFIG_GLOBAL;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  process.env.GIT_CONFIG_NOSYSTEM = '1';

  const gh = await makeOrigin('gh', ['refs/pull/1/head']);
  const gl = await makeOrigin('gl', ['refs/merge-requests/1/head']);
  await writeFile(
    join(home, '.gitconfig'),
    [
      '[protocol "file"]',
      '\tallow = always',
      `[url "file://${gh}"]`,
      `\tinsteadOf = ${GH_URL}`,
      `[url "file://${gl}"]`,
      `\tinsteadOf = ${GL_URL}`,
      '',
    ].join('\n'),
  );
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await rm(root, { recursive: true, force: true });
});

let cloneDir: string;
beforeEach(async () => {
  cloneDir = await mkdtemp(join(root, 'clones-'));
});
afterEach(() => {
  delete process.env.GIT_TRACE;
  delete process.env.GIT_CURL_VERBOSE;
  delete process.env.GIT_TRACE_CURL;
});

describe('SimpleGitClient credentials (Q8)', () => {
  it('GitHub: clone, refresh, sync, fetchPullHead carry a host-scoped header via env only', async () => {
    const calls: Call[] = [];
    const seen: HostRepoRef[] = [];
    const client = new SimpleGitClient(cloneDir, {
      credentials: resolverSpy(seen),
      gitFactory: spyFactory(calls),
    });

    const { path } = await client.clone(GH_REF, GH_URL, { depth: 1, branch: 'main' });
    expect(path).toBe(join(cloneDir, 'acme', 'web'));
    await client.clone(GH_REF, GH_URL, { depth: 1 }); // refresh
    await expectCleanConfig(path);

    const { head } = await client.sync(GH_REF, 'main');
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    await client.fetchPullHead(GH_REF, 1);
    expect(git(path, 'rev-parse', 'pr-1').trim()).toBe(head);
    await expectCleanConfig(path);

    const net = networkCalls(calls);
    expect(net.length).toBe(4);
    for (const c of net) {
      expect(c.env?.GIT_CONFIG_COUNT).toBe('1');
      expect(c.env?.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraHeader');
      expect(c.env?.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${GH_B64}`);
    }
    // Local (non-network) calls never receive the header.
    for (const c of calls.filter((c) => !net.includes(c))) expect(c.env).toBeUndefined();
    expectNoSecretInArgv(calls);
    // Resolver is called per network invocation, always with the GitHub ref.
    expect(seen.length).toBe(4);
    expect(seen.every((r) => r.provider === 'github')).toBe(true);
  });

  it('GitLab: nested path, MR ref fetch, header scoped to gitlab.com, never the GitHub credential', async () => {
    const calls: Call[] = [];
    const seen: HostRepoRef[] = [];
    const client = new SimpleGitClient(cloneDir, {
      credentials: resolverSpy(seen),
      gitFactory: spyFactory(calls),
    });

    const { path } = await client.clone(GL_REF, GL_URL, { depth: 1, branch: 'main' });
    expect(path).toBe(join(cloneDir, '@gitlab.com', 'acme', 'web'));
    await client.clone(GL_REF, GL_URL, { depth: 1 });
    await client.sync(GL_REF, 'main');
    await client.fetchPullHead(GL_REF, 1, { base: 'main' });
    expect(git(path, 'rev-parse', 'refs/devdigest/mr-1').trim()).toMatch(/^[0-9a-f]{40}$/);
    await expectCleanConfig(path);

    const net = networkCalls(calls);
    expect(net.length).toBe(5);
    for (const c of net) {
      expect(c.env?.GIT_CONFIG_KEY_0).toBe('http.https://gitlab.com/.extraHeader');
      expect(c.env?.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${GL_B64}`);
    }
    const mrFetch = net.flatMap((c) => c.argv).find((a) => a.some((x) => x.includes('merge-requests')));
    expect(mrFetch).toEqual(
      expect.arrayContaining(['+refs/merge-requests/1/head:refs/devdigest/mr-1', '--depth', '50']),
    );
    expectNoSecretInArgv(calls);
    expect(seen.every((r) => r.provider === 'gitlab')).toBe(true);
  });

  it('rewrites a legacy token-bearing origin to the tokenless URL in place (AC-47)', async () => {
    const client = new SimpleGitClient(cloneDir, { credentials: resolverSpy([]) });
    const { path } = await client.clone(GH_REF, GH_URL, { depth: 1, branch: 'main' });
    const legacy = 'https://x-access-token:tok@github.com/acme/web.git';
    git(path, 'remote', 'set-url', 'origin', legacy);
    await writeFile(join(path, '.git', 'dd-marker'), 'same clone');
    const before = await stat(path);

    const again = await client.clone(GH_REF, GH_URL, { depth: 1 });
    expect(again.path).toBe(path);
    expect(git(path, 'config', '--get', 'remote.origin.url').trim()).toBe(GH_URL);
    expect(await readFile(join(path, '.git', 'dd-marker'), 'utf8')).toBe('same clone');
    expect((await stat(path)).ino).toBe(before.ino);
    await expectCleanConfig(path);
  });

  it('strips GIT_TRACE / GIT_CURL_VERBOSE from the child env', async () => {
    process.env.GIT_TRACE = '1';
    process.env.GIT_CURL_VERBOSE = '1';
    process.env.GIT_TRACE_CURL = '1';
    const calls: Call[] = [];
    const client = new SimpleGitClient(cloneDir, {
      credentials: resolverSpy([]),
      gitFactory: spyFactory(calls),
    });
    await client.clone(GH_REF, GH_URL, { depth: 1, branch: 'main' });
    const net = networkCalls(calls);
    expect(net.length).toBe(1);
    const env = net[0]!.env!;
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraHeader');
    expect(env).not.toHaveProperty('GIT_TRACE');
    expect(env).not.toHaveProperty('GIT_CURL_VERBOSE');
    expect(env).not.toHaveProperty('GIT_TRACE_CURL');
  });

  it('fails closed on git < 2.31: no header, no URL fallback', async () => {
    const calls: Call[] = [];
    const oldGit = (g: SimpleGit) =>
      Object.assign(g, {
        version: async () => ({ major: 2, minor: 30, patch: 0, agent: 'git', installed: true }),
      }) as SimpleGit;
    const client = new SimpleGitClient(cloneDir, {
      credentials: resolverSpy([]),
      gitFactory: spyFactory(calls, oldGit),
    });
    const { path } = await client.clone(GH_REF, GH_URL, { depth: 1, branch: 'main' });
    const net = networkCalls(calls);
    expect(net.length).toBe(1);
    expect(net[0]!.env).toBeDefined();
    expect(net[0]!.env).not.toHaveProperty('GIT_CONFIG_COUNT');
    expect(net[0]!.env).not.toHaveProperty('GIT_CONFIG_VALUE_0');
    expectNoSecretInArgv(calls);
    await expectCleanConfig(path);
  });

  it('redacts the raw token and the base64 header value from a git error', async () => {
    const leaky = (g: SimpleGit) =>
      Object.assign(g, {
        fetch: async () => {
          throw new Error(
            `fatal: auth failed; header Authorization: Basic ${GH_B64}; token ${GH_TOKEN}; b64 ${GH_B64}`,
          );
        },
      }) as SimpleGit;
    const client = new SimpleGitClient(cloneDir, {
      credentials: resolverSpy([]),
      gitFactory: spyFactory([], leaky),
    });
    await client.clone(GH_REF, GH_URL, { depth: 1, branch: 'main' });
    const err = await client.sync(GH_REF as RepoRef, 'main').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('auth failed');
    expect(msg).not.toContain(GH_TOKEN);
    expect(msg).not.toContain(GH_B64);
  });
});
