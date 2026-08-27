/**
 * Guarded document read/write against a repo's clone working tree (AC-30..AC-33).
 *
 * Every access goes through the path-guard (`assertInsideClone` for read,
 * `assertInsideCloneForWrite` for write) — never through the unguarded
 * `git.readFile` — so Preview, Edit-save, and run-time injection share one
 * security boundary. Writes touch the working tree only: NO git operation
 * (no add/commit/push) is ever performed here; `git.clonePathFor` is a pure
 * path computation.
 *
 * Error semantics (consumed by the service layer for HTTP mapping):
 * - traversal / absolute path / symlink escape → `ValidationError` (guard, fail-closed)
 * - document absent but its parent dir is verified in-tree → `NotFoundError` (404)
 * - any other unresolvable path (incl. missing parent dir) → `ValidationError`,
 *   so out-of-tree existence cannot be probed via symlinked ancestors
 * - non-UTF-8 content on read → `ValidationError` (callers skip-and-record, AC-22)
 */

import { readFile, writeFile } from 'node:fs/promises';
import type { GitClient, RepoRef } from '@devdigest/shared';
import { NotFoundError, ValidationError } from '../../platform/errors.js';
import { assertInsideClone, assertInsideCloneForWrite } from './path-guard.js';

/**
 * The read guard is fail-closed: a genuinely missing file and a containment
 * violation both throw `ValidationError`. Distinguish them without weakening
 * the boundary by re-running the WRITE guard, which enforces the same realpath
 * containment but tolerates an absent target: if it passes, the path is safely
 * in-tree and the document is simply not there → 404. If it also rejects,
 * keep the original fail-closed error.
 */
async function asReadError(cloneRoot: string, relPath: string, err: unknown): Promise<unknown> {
  if (!(err instanceof ValidationError)) return err;
  try {
    await assertInsideCloneForWrite(cloneRoot, relPath);
  } catch {
    return err;
  }
  return new NotFoundError(`Document not found: ${relPath}`);
}

/**
 * Reads a document from the repo clone working tree. `relPath` is
 * repo-relative (as produced by discovery). Returns the file text (UTF-8).
 */
export async function readDocument(
  git: GitClient,
  repoRef: RepoRef,
  relPath: string,
): Promise<string> {
  const cloneRoot = git.clonePathFor(repoRef);

  let absPath: string;
  try {
    absPath = await assertInsideClone(cloneRoot, relPath);
  } catch (err) {
    throw await asReadError(cloneRoot, relPath, err);
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(absPath);
  } catch (err) {
    // Race: file removed between the guard check and the read.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new NotFoundError(`Document not found: ${relPath}`);
    }
    throw err;
  }

  // `buffer.toString('utf8')` silently replaces invalid sequences; decode
  // strictly instead so unreadable/binary content surfaces as an error the
  // run executor can skip-and-record (AC-22).
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ValidationError(`Document is not valid UTF-8: ${relPath}`);
  }
}

/**
 * Writes a document into the repo clone working tree (UTF-8). Working-tree
 * write ONLY — no git add/commit/push. A missing parent directory or any
 * guard violation throws, so a failed save is always reported to the caller,
 * never silently dropped.
 */
export async function writeDocument(
  git: GitClient,
  repoRef: RepoRef,
  relPath: string,
  text: string,
): Promise<void> {
  const cloneRoot = git.clonePathFor(repoRef);
  // Throws ValidationError for traversal/escape/dangling-symlink targets and
  // when the target's parent directory does not exist.
  const absPath = await assertInsideCloneForWrite(cloneRoot, relPath);
  await writeFile(absPath, text, 'utf8');
}
