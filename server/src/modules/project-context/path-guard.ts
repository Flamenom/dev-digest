/**
 * Path traversal / symlink guard for repo-clone file access (AC-30).
 *
 * Every read or write against a clone under `server/clones/` must pass through
 * one of these guards. String checks (`..`, absolute paths) alone are not
 * enough — a symlink *inside* the clone can still point outside it — so
 * containment is verified against `fs.realpath` of both the clone root and
 * the target (fail-closed: any resolution failure rejects).
 */

import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { ValidationError } from '../../platform/errors.js';

/** Rejects obviously hostile rel paths before any fs I/O. */
function assertSafeRelPath(relPath: string): void {
  if (relPath.length === 0) {
    throw new ValidationError('Path must not be empty');
  }
  if (relPath.includes('\0')) {
    throw new ValidationError('Path contains a NUL byte');
  }
  if (path.isAbsolute(relPath)) {
    throw new ValidationError(`Absolute paths are not allowed: ${relPath}`);
  }
  // POSIX-focused, but treat backslashes as separators too so a smuggled
  // `..\\` segment cannot slip through the segment check.
  if (relPath.split(/[/\\]+/).includes('..')) {
    throw new ValidationError(`Path traversal is not allowed: ${relPath}`);
  }
}

/** Resolves the clone root to its real path; fail-closed if it cannot be resolved. */
async function resolveRealRoot(cloneRoot: string): Promise<string> {
  try {
    return await realpath(path.resolve(cloneRoot));
  } catch {
    throw new ValidationError('Clone root does not exist or cannot be resolved');
  }
}

function isContained(realRoot: string, candidate: string): boolean {
  return candidate === realRoot || candidate.startsWith(realRoot + path.sep);
}

/**
 * Validates that `relPath` resolves to a real filesystem location inside
 * `cloneRoot` (symlink-safe, for READ access). Returns the validated
 * absolute (real) path; throws `ValidationError` otherwise — including when
 * the target does not exist, so the guard stays fail-closed.
 */
export async function assertInsideClone(cloneRoot: string, relPath: string): Promise<string> {
  assertSafeRelPath(relPath);
  const realRoot = await resolveRealRoot(cloneRoot);
  const resolved = path.resolve(realRoot, relPath);

  let real: string;
  try {
    real = await realpath(resolved);
  } catch {
    throw new ValidationError(`Path does not exist or cannot be resolved: ${relPath}`);
  }
  if (!isContained(realRoot, real)) {
    throw new ValidationError(`Path escapes the repository clone: ${relPath}`);
  }
  return real;
}

/**
 * Same containment checks as `assertInsideClone`, but for WRITE access:
 * tolerates a not-yet-existing target file by realpath-ing its PARENT
 * directory instead (a brand-new in-tree file is allowed; a symlinked
 * parent — or a dangling symlink at the target itself — is not).
 * Returns the validated absolute path to write to.
 */
export async function assertInsideCloneForWrite(
  cloneRoot: string,
  relPath: string,
): Promise<string> {
  assertSafeRelPath(relPath);
  const realRoot = await resolveRealRoot(cloneRoot);
  const resolved = path.resolve(realRoot, relPath);

  // Existing target: identical to the read check (an in-tree symlink whose
  // realpath is outside the clone is rejected here).
  let real: string | null = null;
  try {
    real = await realpath(resolved);
  } catch {
    real = null;
  }
  if (real !== null) {
    if (!isContained(realRoot, real)) {
      throw new ValidationError(`Path escapes the repository clone: ${relPath}`);
    }
    return real;
  }

  // Target does not resolve. If something IS there (a dangling symlink),
  // writing through it would follow the link — reject.
  try {
    const stat = await lstat(resolved);
    if (stat.isSymbolicLink()) {
      throw new ValidationError(`Path is a dangling symlink: ${relPath}`);
    }
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    // ENOENT — genuinely absent, fine for a brand-new write.
  }

  // Brand-new file: the parent directory must exist and really live in-tree.
  let realParent: string;
  try {
    realParent = await realpath(path.dirname(resolved));
  } catch {
    throw new ValidationError(`Parent directory does not exist: ${relPath}`);
  }
  if (!isContained(realRoot, realParent)) {
    throw new ValidationError(`Path escapes the repository clone: ${relPath}`);
  }
  return path.join(realParent, path.basename(resolved));
}
