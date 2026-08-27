import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { GitClient, RepoRef } from '@devdigest/shared';
import { readDocument, writeDocument } from '../src/modules/project-context/documents.js';
import { NotFoundError, ValidationError } from '../src/platform/errors.js';

/**
 * Hermetic tests for the guarded document read/write (AC-30..AC-33) against a
 * real temp "clone" dir + a fake GitClient. The GitClient contract here is
 * paths-only: `clonePathFor` is the SOLE method the documents module may call
 * — no git side effects (no readFile/diff/clone/sync) ever happen.
 */

const repoRef: RepoRef = { owner: 'acme', name: 'widgets' };

let clone: string;
let git: GitClient;
let gitSpies: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(async () => {
  clone = await mkdtemp(path.join(os.tmpdir(), 'pc-docs-'));
  await mkdir(path.join(clone, 'docs'), { recursive: true });
  await writeFile(path.join(clone, 'docs', 'spec.md'), '# API spec\ninvariant: no live keys\n', 'utf8');

  // Fake GitClient: every method is a spy; only clonePathFor returns a value.
  gitSpies = {
    clonePathFor: vi.fn(() => clone),
    clone: vi.fn(),
    fetchPullHead: vi.fn(),
    sync: vi.fn(),
    currentHead: vi.fn(),
    diffNameOnly: vi.fn(),
    diff: vi.fn(),
    blame: vi.fn(),
    log: vi.fn(),
    readFile: vi.fn(),
  };
  git = gitSpies as unknown as GitClient;
});

afterEach(async () => {
  await rm(clone, { recursive: true, force: true });
});

describe('readDocument', () => {
  it('returns the document text for an in-tree path (AC-32)', async () => {
    const text = await readDocument(git, repoRef, 'docs/spec.md');
    expect(text).toBe('# API spec\ninvariant: no live keys\n');
  });

  it('missing in-tree document → NotFoundError (404), not a guard error', async () => {
    const err = await readDocument(git, repoRef, 'docs/missing.md').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).statusCode).toBe(404);
  });

  it('traversal is refused with ValidationError', async () => {
    await expect(readDocument(git, repoRef, '../../etc/passwd')).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(readDocument(git, repoRef, '/etc/passwd')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('non-UTF-8 content → ValidationError (strict decode, AC-22 skip-and-record input)', async () => {
    // 0xFF 0xFE 0xFD is not a valid UTF-8 sequence.
    await writeFile(path.join(clone, 'docs', 'binary.md'), Buffer.from([0xff, 0xfe, 0xfd]));
    await expect(readDocument(git, repoRef, 'docs/binary.md')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('writeDocument', () => {
  it('persists the text, and a subsequent read returns it (AC-32/AC-33)', async () => {
    await writeDocument(git, repoRef, 'docs/new.md', '# fresh doc\n');
    expect(await readFile(path.join(clone, 'docs', 'new.md'), 'utf8')).toBe('# fresh doc\n');
    expect(await readDocument(git, repoRef, 'docs/new.md')).toBe('# fresh doc\n');
  });

  it('overwrites an existing in-tree document', async () => {
    await writeDocument(git, repoRef, 'docs/spec.md', 'v2 body\n');
    expect(await readDocument(git, repoRef, 'docs/spec.md')).toBe('v2 body\n');
  });

  it('traversal is refused with ValidationError and nothing is written', async () => {
    await expect(
      writeDocument(git, repoRef, '../escape.md', 'nope'),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(writeDocument(git, repoRef, '/etc/passwd', 'nope')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('GitClient usage boundary', () => {
  it('only clonePathFor is ever called — no git side effects on read or write', async () => {
    await readDocument(git, repoRef, 'docs/spec.md');
    await writeDocument(git, repoRef, 'docs/other.md', 'x');
    await readDocument(git, repoRef, 'docs/missing.md').catch(() => undefined);
    await writeDocument(git, repoRef, '../escape.md', 'x').catch(() => undefined);

    expect(gitSpies.clonePathFor).toHaveBeenCalled();
    for (const [name, spy] of Object.entries(gitSpies)) {
      if (name === 'clonePathFor') continue;
      expect(spy, `GitClient.${name} must never be called by documents.ts`).not.toHaveBeenCalled();
    }
  });
});
