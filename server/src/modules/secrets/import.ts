/**
 * One-time secrets import (AC-43, AC-44): legacy local secrets JSON file +
 * legacy env vars → encrypted store, used by `src/cli/secrets-import.ts`.
 *
 * - All-or-nothing: every insert and the audit event run in ONE transaction;
 *   any failure rolls back and nothing is written.
 * - Idempotent: `insertIfAbsent` never overwrites a stored key (a key set in
 *   the UI, or by an earlier run, is reported `skipped`).
 * - Unknown key names in the file are ignored (reported by name).
 * - The source file is only READ (through the injected `readSource`).
 * - Output and errors name keys only — never a value, ciphertext or the master key.
 *
 * Application ring: no SQL, no Fastify, no container; file I/O is injected.
 */
import type { AuditLog, SecretKey, SecretStore } from '@devdigest/shared';
import { SECRET_KEY_BYTES, aadFor, keyId, seal } from '../../platform/crypto/secret-box.js';
import { envNamesFor } from './service.js';

/** A failure whose message is safe to print (names settings/keys/paths only). */
export class SecretsImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsImportError';
  }
}

export interface SecretsImportDeps<Tx> {
  store: SecretStore<Tx>;
  audit: AuditLog<Tx>;
  /** Current master key; null/invalid → abort before any write (AC-44). */
  masterKey: Buffer | null;
  /** Team workspace the rows belong to. */
  workspaceId: string;
  /** The managed key names (`SECRET_KEY_BY_PROVIDER` values). */
  managedKeys: readonly SecretKey[];
  /** Legacy environment (only managed names + aliases are read). */
  env: Readonly<Record<string, string | undefined>>;
  /** Reads the legacy file as UTF-8. Injected so this module performs no I/O itself. */
  readSource: (path: string) => Promise<string>;
  /** Acting user recorded on rows + audit; null for the operator CLI. */
  actorUserId?: string | null;
}

export interface SecretsImportOptions {
  /** Legacy secrets JSON path; omitted → environment values only. */
  filePath?: string;
}

export interface SecretsImportResult {
  imported: string[];
  skipped: string[];
  ignored: string[];
}

/** Parse the legacy JSON. Malformed / non-object → abort (AC-44). */
function parseLegacyFile(raw: string, path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never echo the parser message: it can quote file contents.
    throw new SecretsImportError(`${path} is not valid JSON — nothing was imported`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SecretsImportError(`${path} must contain a JSON object of KEY: value — nothing was imported`);
  }
  return parsed as Record<string, unknown>;
}

export async function importSecrets<Tx>(
  deps: SecretsImportDeps<Tx>,
  opts: SecretsImportOptions = {},
): Promise<SecretsImportResult> {
  const { masterKey, managedKeys, env, store, audit, workspaceId } = deps;
  if (!masterKey || masterKey.length !== SECRET_KEY_BYTES) {
    throw new SecretsImportError(
      'a valid SECRETS_MASTER_KEY (base64, 32 bytes) is required — nothing was imported',
    );
  }
  const currentKeyId = keyId(masterKey);
  const managed = new Set<string>(managedKeys);

  // ── collect candidate values (file wins over env, like LocalSecretsProvider) ──
  let file: Record<string, unknown> = {};
  if (opts.filePath) {
    let raw: string;
    try {
      raw = await deps.readSource(opts.filePath);
    } catch {
      throw new SecretsImportError(`cannot read ${opts.filePath} — nothing was imported`);
    }
    file = parseLegacyFile(raw, opts.filePath);
  }

  const ignored = Object.keys(file)
    .filter((name) => !managed.has(name))
    .sort();

  const candidates: Array<{ key: SecretKey; value: string }> = [];
  for (const key of managedKeys) {
    let value: string | undefined;
    if (Object.hasOwn(file, key)) {
      const v = file[key];
      if (typeof v !== 'string') {
        throw new SecretsImportError(`${key} in the file is not a string — nothing was imported`);
      }
      if (v.length > 0) value = v;
    }
    if (value === undefined) {
      for (const name of envNamesFor(key)) {
        const v = env[name];
        if (typeof v === 'string' && v.length > 0) {
          value = v;
          break;
        }
      }
    }
    if (value !== undefined) candidates.push({ key, value });
  }

  // ── one transaction: insert-if-absent each, then the audit event ──
  return store.transaction(async (tx) => {
    const imported: string[] = [];
    const skipped: string[] = [];
    for (const { key, value } of candidates) {
      const sealed = seal(value, masterKey, aadFor(workspaceId, key));
      const inserted = await store.insertIfAbsent(
        {
          workspaceId,
          keyName: key,
          ciphertext: sealed.ciphertext,
          nonce: sealed.nonce,
          keyId: currentKeyId,
          updatedBy: deps.actorUserId ?? null,
        },
        tx,
      );
      (inserted ? imported : skipped).push(key);
    }
    await audit.record(
      {
        workspaceId,
        actorUserId: deps.actorUserId ?? null,
        action: 'secrets.import',
        targetType: 'secret_store',
        targetId: null,
        metadata: { imported, skipped, ignored, from_file: Boolean(opts.filePath) },
      },
      tx,
    );
    return { imported, skipped, ignored };
  });
}

// ── CLI glue (argument parsing + report), kept here so it is testable ────────

/** `[--file <path>]` (also `--file=<path>`). Anything else → usage error. */
export function parseImportArgs(argv: readonly string[]): SecretsImportOptions {
  const opts: SecretsImportOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--file') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new SecretsImportError('--file needs a path');
      opts.filePath = next;
      i++;
    } else if (arg.startsWith('--file=')) {
      const path = arg.slice('--file='.length);
      if (!path) throw new SecretsImportError('--file needs a path');
      opts.filePath = path;
    } else {
      throw new SecretsImportError(`unknown argument ${JSON.stringify(arg)} — usage: secrets:import [--file <path>]`);
    }
  }
  return opts;
}

/** Report lines — key names only. */
export function formatImportReport(result: SecretsImportResult): string[] {
  const list = (names: string[]) => (names.length > 0 ? names.join(', ') : '(none)');
  return [
    `imported: ${list(result.imported)}`,
    `skipped (already stored, not overwritten): ${list(result.skipped)}`,
    `ignored (unknown key names): ${list(result.ignored)}`,
  ];
}

export interface ImportIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/**
 * A printable, value-free description of any failure. Only our own errors keep
 * their message; anything else (e.g. a driver error, which may quote row bytes)
 * is reduced to its name/code.
 */
export function describeImportError(err: unknown): string {
  if (err instanceof SecretsImportError) return err.message;
  const code =
    err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
      ? ` (${(err as { code: string }).code})`
      : '';
  const name = err instanceof Error ? err.name : 'Error';
  return `${name}${code} — the import was rolled back, nothing was written`;
}

/** Run the import end-to-end; returns the process exit code (0 ok, 1 failure). */
export async function runSecretsImport<Tx>(
  argv: readonly string[],
  deps: SecretsImportDeps<Tx>,
  io: ImportIo,
): Promise<number> {
  try {
    const opts = parseImportArgs(argv);
    if (!opts.filePath) io.out('no --file given — importing environment values only');
    const result = await importSecrets(deps, opts);
    for (const line of formatImportReport(result)) io.out(line);
    return 0;
  } catch (err) {
    io.err(`secrets import failed: ${describeImportError(err)}`);
    return 1;
  }
}
