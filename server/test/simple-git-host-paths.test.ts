import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SimpleGit } from 'simple-git';
import type { HostRepoRef } from '@devdigest/shared';
import { SimpleGitClient, type GitFactory } from '../src/adapters/git/simple-git.js';

/** Hermetic: temp dirs only, no git network. */
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dd-git-paths-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const gitlab = (owner: string, name: string): HostRepoRef => ({
  owner,
  name,
  fullName: `${owner}/${name}`,
  provider: 'gitlab',
  host: 'gitlab.com',
});

describe('SimpleGitClient.clonePathFor', () => {
  it('keeps the GitHub layout unchanged and namespaces GitLab under @gitlab.com', () => {
    const git = new SimpleGitClient(dir);
    // AC-47: legacy RepoRef (no provider) and explicit github both map to <dir>/<owner>/<name>.
    expect(git.clonePathFor({ owner: 'acme', name: 'web' })).toBe(join(dir, 'acme', 'web'));
    expect(
      git.clonePathFor({
        owner: 'acme',
        name: 'web',
        fullName: 'acme/web',
        provider: 'github',
        host: 'github.com',
      } as HostRepoRef),
    ).toBe(join(dir, 'acme', 'web'));
    // AC-15: the same path on GitLab is a different clone.
    expect(git.clonePathFor(gitlab('acme', 'web'))).toBe(join(dir, '@gitlab.com', 'acme', 'web'));
    // Nested GitLab namespace.
    expect(git.clonePathFor(gitlab('a/b/c/d', 'e'))).toBe(
      join(dir, '@gitlab.com', 'a', 'b', 'c', 'd', 'e'),
    );
  });

  it('rejects owners that would escape the clone root', () => {
    const git = new SimpleGitClient(dir);
    expect(() => git.clonePathFor({ owner: '../x', name: 'web' })).toThrow(/clone root/);
    expect(() => git.clonePathFor({ owner: '..', name: '..' })).toThrow();
    expect(() => git.clonePathFor(gitlab('../x', 'web'))).toThrow();
    expect(() => git.clonePathFor(gitlab('a/../../x', 'web'))).toThrow();
  });
});

describe('SimpleGitClient error redaction', () => {
  it('redacts userinfo from a surfaced git error', async () => {
    const failing = {
      raw: async () => {
        throw new Error('no origin');
      },
      fetch: async () => {
        throw new Error("fatal: unable to access 'https://oauth2:tok@gitlab.com/acme/web.git/'");
      },
      version: async () => ({ major: 2, minor: 40, patch: 0, agent: '', installed: true }),
    } as unknown as SimpleGit;
    const factory: GitFactory = () => failing;
    const git = new SimpleGitClient(dir, { gitFactory: factory });

    const err = await git.sync(gitlab('acme', 'web'), 'main').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('oauth2:tok@');
    expect((err as Error).message).not.toContain('tok@');
    expect((err as Error).message).toContain('unable to access');
  });

  it('refuses a clone URL carrying credentials without echoing them', async () => {
    const git = new SimpleGitClient(dir);
    const err = await git
      .clone({ owner: 'acme', name: 'web' }, 'https://x-access-token:tok@github.com/acme/web.git')
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/must not carry credentials/);
    expect((err as Error).message).not.toContain('tok@');
  });
});
