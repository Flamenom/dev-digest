import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { assertInsideClone, assertInsideCloneForWrite } from '../src/modules/project-context/path-guard.js';
import { ValidationError } from '../src/platform/errors.js';

/**
 * Hermetic tests for the repo-clone path guard (AC-30). Real temp dirs +
 * real symlinks (local fs only — no network, no git): string-level traversal,
 * absolute paths, AND symlink escapes must be rejected for read and write;
 * in-tree reads and brand-new in-tree writes must be accepted. Fail-closed:
 * a missing file on READ is a ValidationError too.
 */

let root: string; // temp sandbox
let clone: string; // the "repo clone" under guard
let outside: string; // sibling dir the guard must never reach

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'pc-guard-'));
  clone = path.join(root, 'clone');
  outside = path.join(root, 'outside');
  await mkdir(path.join(clone, 'docs'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(clone, 'docs', 'spec.md'), '# spec\n', 'utf8');
  await writeFile(path.join(outside, 'secret.md'), 'TOP SECRET\n', 'utf8');
  // Symlink INSIDE the clone pointing OUTSIDE it — the classic escape.
  await symlink(path.join(outside, 'secret.md'), path.join(clone, 'escape.md'));
  // Dangling symlink — its target does not exist.
  await symlink(path.join(outside, 'nope.md'), path.join(clone, 'dangling.md'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('assertInsideClone (read guard)', () => {
  it('accepts an in-tree relative path and returns the real absolute path', async () => {
    const abs = await assertInsideClone(clone, 'docs/spec.md');
    expect(abs).toBe(await realpath(path.join(clone, 'docs', 'spec.md')));
  });

  it('rejects `..` traversal (../../etc/passwd)', async () => {
    await expect(assertInsideClone(clone, '../../etc/passwd')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects absolute paths (/etc/passwd)', async () => {
    await expect(assertInsideClone(clone, '/etc/passwd')).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an in-tree symlink whose target escapes the clone', async () => {
    await expect(assertInsideClone(clone, 'escape.md')).rejects.toBeInstanceOf(ValidationError);
  });

  it('is fail-closed: a missing file rejects instead of resolving', async () => {
    await expect(assertInsideClone(clone, 'docs/missing.md')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects backslash-smuggled traversal segments', async () => {
    await expect(assertInsideClone(clone, '..\\..\\etc\\passwd')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects empty and NUL-byte paths', async () => {
    await expect(assertInsideClone(clone, '')).rejects.toBeInstanceOf(ValidationError);
    await expect(assertInsideClone(clone, 'docs/a\0b.md')).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('assertInsideCloneForWrite (write guard)', () => {
  it('accepts a brand-new in-tree file whose parent dir exists (AC-30)', async () => {
    const abs = await assertInsideCloneForWrite(clone, 'docs/new.md');
    expect(abs).toBe(path.join(await realpath(path.join(clone, 'docs')), 'new.md'));
  });

  it('accepts an existing in-tree file', async () => {
    const abs = await assertInsideCloneForWrite(clone, 'docs/spec.md');
    expect(abs).toBe(await realpath(path.join(clone, 'docs', 'spec.md')));
  });

  it('rejects `..` traversal (../../etc/passwd)', async () => {
    await expect(assertInsideCloneForWrite(clone, '../../etc/passwd')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects absolute paths (/etc/passwd)', async () => {
    await expect(assertInsideCloneForWrite(clone, '/etc/passwd')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects an in-tree symlink whose target escapes the clone', async () => {
    await expect(assertInsideCloneForWrite(clone, 'escape.md')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects a dangling symlink target (writing through it would follow the link)', async () => {
    await expect(assertInsideCloneForWrite(clone, 'dangling.md')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects a new file whose parent directory does not exist', async () => {
    await expect(assertInsideCloneForWrite(clone, 'ghost-dir/new.md')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects a new file under a symlinked parent that escapes the clone', async () => {
    // Symlinked DIRECTORY inside the clone pointing outside: a "new" file
    // under it would land outside the tree.
    await symlink(outside, path.join(clone, 'linked-dir'));
    await expect(assertInsideCloneForWrite(clone, 'linked-dir/new.md')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
